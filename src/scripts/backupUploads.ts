import { spawn } from "child_process";
import { access, mkdir, readdir, stat, unlink } from "fs/promises";
import path from "path";

const BACKUP_DIR = path.join(process.cwd(), "backups");
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PARKING_SUBDIR = "parking";
const RETENTION_DAYS = 30;

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

async function parkingDirExists(): Promise<boolean> {
  try {
    await access(path.join(UPLOADS_DIR, PARKING_SUBDIR));
    return true;
  } catch {
    return false;
  }
}

async function archiveToFile(filepath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-czf", filepath, "-C", UPLOADS_DIR, PARKING_SUBDIR]);

    let stderr = "";
    tar.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar muvaffaqiyatsiz tugadi (kod ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function cleanupOldUploadBackups(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await readdir(BACKUP_DIR);

  for (const file of files) {
    if (!file.startsWith("uploads_")) continue;

    const fullPath = path.join(BACKUP_DIR, file);
    const stats = await stat(fullPath);
    if (stats.mtimeMs < cutoff) {
      await unlink(fullPath);
      console.log(`Eski rasm backup o'chirildi: ${file}`);
    }
  }
}

export async function runUploadsBackup(): Promise<string | null> {
  await mkdir(BACKUP_DIR, { recursive: true });

  if (!(await parkingDirExists())) {
    console.log("uploads/parking/ mavjud emas — rasm backup o'tkazib yuborildi");
    await cleanupOldUploadBackups();
    return null;
  }

  const filename = `uploads_${timestamp()}.tar.gz`;
  const filepath = path.join(BACKUP_DIR, filename);

  await archiveToFile(filepath);
  await cleanupOldUploadBackups();

  return filepath;
}

if (require.main === module) {
  runUploadsBackup()
    .then((filepath) => {
      console.log(
        filepath
          ? `Rasm backup muvaffaqiyatli yaratildi: ${filepath}`
          : "Rasm backup o'tkazib yuborildi (uploads/parking/ topilmadi)"
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Rasm backup xatosi:", err);
      process.exit(1);
    });
}
