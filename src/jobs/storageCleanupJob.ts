import { promises as fs } from "fs";
import path from "path";
import cron from "node-cron";
import { db } from "@/config/db";
import { env } from "@/config/env";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "parking");

interface FileEntry {
  fullPath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

async function collectFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(fullPath);
      } else if (child.isFile() && !child.name.endsWith(".tmp")) {
        const stats = await fs.stat(fullPath);
        entries.push({
          fullPath,
          relativePath: path.relative(process.cwd(), fullPath).split(path.sep).join("/"),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      }
    }
  }
  try {
    await walk(UPLOAD_ROOT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return entries;
}

async function clearImageReference(relativePath: string): Promise<void> {
  const columns = [
    "image_entry",
    "image_exit",
    "entry_vehicle_image_path",
    "entry_plate_image_path",
    "exit_vehicle_image_path",
    "exit_plate_image_path",
  ];
  for (const column of columns) {
    await db("tb_parking_sessions").where({ [column]: relativePath }).update({ [column]: null });
  }
}

export async function runStorageCleanup(): Promise<void> {
  const limitBytes = env.uploadsMaxSizeMB * 1024 * 1024;
  const files = await collectFiles();
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  console.log(
    `Rasm xotirasi tekshiruvi: umumiy hajm ${(totalSize / 1024 / 1024).toFixed(1)} MB / limit ${env.uploadsMaxSizeMB} MB (${files.length} ta fayl)`
  );

  if (totalSize <= limitBytes) {
    console.log("Xotira limitdan oshmagan — tozalash kerak emas");
    return;
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const activeRows = await db("tb_parking_sessions")
    .whereIn("status", ["active", "awaiting_payment"])
    .select(
      "image_entry",
      "image_exit",
      "entry_vehicle_image_path",
      "entry_plate_image_path",
      "exit_vehicle_image_path",
      "exit_plate_image_path"
    );
  const protectedPaths = new Set(
    activeRows.flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string"))
  );

  let runningSize = totalSize;
  let deletedCount = 0;

  for (const file of files) {
    if (runningSize <= limitBytes) break;
    if (protectedPaths.has(file.relativePath)) continue;

    await fs.unlink(file.fullPath);
    await clearImageReference(file.relativePath);

    runningSize -= file.size;
    deletedCount++;
  }

  console.log(
    `Tozalash yakunlandi: ${deletedCount} ta fayl o'chirildi, yangi umumiy hajm ${(runningSize / 1024 / 1024).toFixed(1)} MB`
  );
}

const CLEANUP_SCHEDULE = "0 4 * * *";

export function scheduleStorageCleanupJob(): void {
  cron.schedule(CLEANUP_SCHEDULE, async () => {
    try {
      await runStorageCleanup();
    } catch (err) {
      console.error("Rasm xotirasini tozalashda xato:", err);
    }
  });

  console.log(`Rasm xotirasini tozalash job rejalashtirildi (cron: "${CLEANUP_SCHEDULE}")`);
}

if (require.main === module) {
  runStorageCleanup()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Tozalash xatosi:", err);
      process.exit(1);
    });
}
