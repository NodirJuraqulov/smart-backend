import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "parking");

function todayFolder(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function saveParkingImage(imageBase64: string): Promise<string> {
  const dayFolder = todayFolder();
  const dirPath = path.join(UPLOAD_DIR, dayFolder);
  await mkdir(dirPath, { recursive: true });
  const filename = `${randomUUID()}.jpg`;
  const buffer = Buffer.from(imageBase64, "base64");
  await writeFile(path.join(dirPath, filename), buffer);
  return path.join("uploads", "parking", dayFolder, filename);
}
