import { promises as fs } from "fs";
import path from "path";
import cron from "node-cron";
import { db } from "@/config/db";
import { env } from "@/config/env";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "parking");

interface FileEntry {
  fullPath: string;
  relativePath: string;
  dayFolder: string | null;
  size: number;
  mtimeMs: number;
}

async function collectFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  let rootEntries;
  try {
    rootEntries = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const entry of rootEntries) {
    if (entry.isDirectory()) {
      const dayFolder = entry.name;
      const dayPath = path.join(UPLOAD_ROOT, dayFolder);
      const dayFiles = await fs.readdir(dayPath, { withFileTypes: true });

      for (const file of dayFiles) {
        if (!file.isFile()) continue;
        const fullPath = path.join(dayPath, file.name);
        const stats = await fs.stat(fullPath);
        entries.push({
          fullPath,
          relativePath: path.join("uploads", "parking", dayFolder, file.name),
          dayFolder,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      }
    } else if (entry.isFile()) {
      const fullPath = path.join(UPLOAD_ROOT, entry.name);
      const stats = await fs.stat(fullPath);
      entries.push({
        fullPath,
        relativePath: path.join("uploads", "parking", entry.name),
        dayFolder: null,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }

  return entries;
}

async function clearImageReference(relativePath: string): Promise<void> {
  await db("tb_parking_sessions").where({ image_entry: relativePath }).update({ image_entry: null });
  await db("tb_parking_sessions").where({ image_exit: relativePath }).update({ image_exit: null });
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

  let runningSize = totalSize;
  let deletedCount = 0;
  const touchedDayFolders = new Set<string>();

  for (const file of files) {
    if (runningSize <= limitBytes) break;

    await fs.unlink(file.fullPath);
    await clearImageReference(file.relativePath);

    runningSize -= file.size;
    deletedCount++;
    if (file.dayFolder) touchedDayFolders.add(file.dayFolder);
  }

  for (const dayFolder of touchedDayFolders) {
    const dayPath = path.join(UPLOAD_ROOT, dayFolder);
    const remaining = await fs.readdir(dayPath);
    if (remaining.length === 0) {
      await fs.rmdir(dayPath);
    }
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
