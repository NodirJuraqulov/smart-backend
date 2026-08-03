import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { env } from "@/config/env";

const BACKUP_DIR = path.join(process.cwd(), "backups");
const RETENTION_DAYS = 30;

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`
  );
}

async function dumpToFile(filepath: string): Promise<void> {
  const dump = spawn(
    "mysqldump",
    ["-h", env.db.host, "-P", String(env.db.port), "-u", env.db.user, "--single-transaction", env.db.name],
    { env: { ...process.env, MYSQL_PWD: env.db.password } }
  );
  let stderr = "";
  dump.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = new Promise<number>((resolve, reject) => {
    dump.once("error", reject);
    dump.once("close", (code) => resolve(code ?? -1));
  });
  let code: number;
  try {
    [, code] = await Promise.all([pipeline(dump.stdout, createGzip(), createWriteStream(filepath)), exitCode]);
  } catch (err) {
    await unlink(filepath).catch(() => undefined);
    throw err;
  }
  if (code !== 0) {
    await unlink(filepath).catch(() => undefined);
    throw new Error(`mysqldump muvaffaqiyatsiz tugadi (kod ${code}): ${stderr}`);
  }
}

async function cleanupOldBackups(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await readdir(BACKUP_DIR);

  for (const file of files) {
    const fullPath = path.join(BACKUP_DIR, file);
    const stats = await stat(fullPath);
    if (stats.mtimeMs < cutoff) {
      await unlink(fullPath);
      console.log(`Eski backup o'chirildi: ${file}`);
    }
  }
}

export async function runBackup(): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });

  const filename = `stoyanka_db_${timestamp()}.sql.gz`;
  const filepath = path.join(BACKUP_DIR, filename);

  await dumpToFile(filepath);
  await cleanupOldBackups();

  return filepath;
}

if (require.main === module) {
  runBackup()
    .then((filepath) => {
      console.log(`Backup muvaffaqiyatli yaratildi: ${filepath}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backup xatosi:", err);
      process.exit(1);
    });
}
