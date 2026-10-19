import { promises as fs } from "fs";
import path from "path";
import cron from "node-cron";
import { db } from "@/config/db";
import { env } from "@/config/env";

const EVENT_UPLOAD_ROOT = path.resolve(process.cwd(), "uploads", "parking-events");
const SESSION_IMAGE_COLUMNS = [
  "image_entry",
  "image_exit",
  "entry_overview_image_path",
  "entry_vehicle_image_path",
  "entry_plate_image_path",
  "exit_overview_image_path",
  "exit_vehicle_image_path",
  "exit_plate_image_path",
] as const;

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export interface WebhookImagesCleanupResult {
  examined: number;
  deleted: number;
  errors: number;
  freedBytes: number;
  skipped: {
    fresh: number;
    sessionReference: number;
    symlink: number;
    directory: number;
    nonRegular: number;
    outside: number;
  };
}

export interface WebhookImagesCleanupOptions {
  rootDir?: string;
  now?: Date;
  retentionDays?: number;
  maxPerRun?: number;
  findSessionReferencedPaths?: (paths: string[]) => Promise<Set<string>>;
  deleteFile?: (filePath: string) => Promise<void>;
}

function createResult(): WebhookImagesCleanupResult {
  return {
    examined: 0,
    deleted: 0,
    errors: 0,
    freedBytes: 0,
    skipped: {
      fresh: 0,
      sessionReference: 0,
      symlink: 0,
      directory: 0,
      nonRegular: 0,
      outside: 0,
    },
  };
}

function isInsideRoot(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function toStoredPath(rootDir: string, filePath: string): string | null {
  if (!isInsideRoot(rootDir, filePath)) return null;
  const relative = path.relative(rootDir, filePath).split(path.sep).join("/");
  return `uploads/parking-events/${relative}`;
}

async function loadSessionReferencedPaths(): Promise<Set<string>> {
  const rows = await db("tb_parking_sessions")
    .select(...SESSION_IMAGE_COLUMNS)
    .where(function querySessionPaths() {
      for (const column of SESSION_IMAGE_COLUMNS) {
        this.orWhere(column, "like", "uploads/parking-events/%");
      }
    });
  const found = new Set<string>();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string" && value.startsWith("uploads/parking-events/")) found.add(value);
    }
  }
  return found;
}

function logResult(result: WebhookImagesCleanupResult): void {
  console.log(
    "WEBHOOK_IMAGES_CLEANUP " +
      `examined=${result.examined} deleted=${result.deleted} ` +
      `skipped_fresh=${result.skipped.fresh} ` +
      `skipped_session_reference=${result.skipped.sessionReference} ` +
      `skipped_symlink=${result.skipped.symlink} ` +
      `skipped_directory=${result.skipped.directory} ` +
      `skipped_non_regular=${result.skipped.nonRegular} ` +
      `skipped_outside=${result.skipped.outside} errors=${result.errors} ` +
      `freed_mb=${(result.freedBytes / 1024 / 1024).toFixed(2)}`
  );
}

export async function runWebhookImagesCleanup(
  options: WebhookImagesCleanupOptions = {}
): Promise<WebhookImagesCleanupResult> {
  const rootDir = path.resolve(options.rootDir ?? EVENT_UPLOAD_ROOT);
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? env.webhookImagesCleanup.retentionDays;
  const maxPerRun = options.maxPerRun ?? env.webhookImagesCleanup.maxPerRun;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let sessionPathsPromise: Promise<Set<string>> | null = null;
  const lookupSessionPaths =
    options.findSessionReferencedPaths ??
    (async (paths: string[]) => {
      sessionPathsPromise ??= loadSessionReferencedPaths();
      const sessionPaths = await sessionPathsPromise;
      return new Set(paths.filter((storedPath) => sessionPaths.has(storedPath)));
    });
  const deleteFile = options.deleteFile ?? fs.unlink;
  const result = createResult();
  let candidates: CandidateFile[] = [];

  const processCandidates = async (): Promise<void> => {
    if (candidates.length === 0 || result.deleted >= maxPerRun) return;
    const storedPaths = candidates.map((candidate) => candidate.relativePath);
    let sessionPaths: Set<string>;
    try {
      sessionPaths = await lookupSessionPaths(storedPaths);
    } catch {
      result.errors += candidates.length;
      candidates = [];
      return;
    }
    for (const candidate of candidates) {
      if (result.deleted >= maxPerRun) break;
      if (sessionPaths.has(candidate.relativePath)) {
        result.skipped.sessionReference++;
        continue;
      }
      try {
        await deleteFile(candidate.absolutePath);
        result.deleted++;
        result.freedBytes += candidate.size;
      } catch {
        result.errors++;
      }
    }
    candidates = [];
  };

  const walk = async (directory: string): Promise<void> => {
    if (result.deleted >= maxPerRun) return;
    let handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      handle = await fs.opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.errors++;
      return;
    }
    for await (const entry of handle) {
      if (result.deleted >= maxPerRun) break;
      const filePath = path.resolve(directory, entry.name);
      if (!isInsideRoot(rootDir, filePath)) {
        result.skipped.outside++;
        continue;
      }
      if (entry.isSymbolicLink()) {
        result.skipped.symlink++;
        continue;
      }
      if (entry.isDirectory()) {
        result.skipped.directory++;
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) {
        result.skipped.nonRegular++;
        continue;
      }
      let stats: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stats = await fs.lstat(filePath);
      } catch {
        result.errors++;
        continue;
      }
      if (stats.isSymbolicLink()) {
        result.skipped.symlink++;
        continue;
      }
      if (!stats.isFile()) {
        result.skipped.nonRegular++;
        continue;
      }
      result.examined++;
      if (stats.mtimeMs >= cutoffMs) {
        result.skipped.fresh++;
        continue;
      }
      const relativePath = toStoredPath(rootDir, filePath);
      if (!relativePath) {
        result.skipped.outside++;
        continue;
      }
      candidates.push({ absolutePath: filePath, relativePath, size: stats.size });
      const remainingLimit = maxPerRun - result.deleted;
      if (candidates.length >= Math.min(250, remainingLimit)) await processCandidates();
    }
  };

  try {
    await walk(rootDir);
    await processCandidates();
  } catch {
    result.errors++;
  }
  logResult(result);
  return result;
}

export function scheduleWebhookImagesCleanupJob(): void {
  if (!env.webhookImagesCleanup.enabled) return;
  cron.schedule(env.webhookImagesCleanup.cron, async () => {
    try {
      await runWebhookImagesCleanup();
    } catch (error) {
      console.error("WEBHOOK_IMAGES_CLEANUP_FAILED", error);
    }
  });
}
