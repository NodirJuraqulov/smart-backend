import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { env } from "@/config/env";
import {
  runWebhookImagesCleanup,
  scheduleWebhookImagesCleanupJob,
} from "@/jobs/webhookImagesCleanupJob";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
}));

vi.mock("node-cron", () => ({ default: { schedule: mocks.schedule } }));

const now = new Date("2026-10-19T12:00:00.000Z");
let tempRoot: string;

async function writeImage(relativePath: string, ageDays: number): Promise<string> {
  const filePath = path.join(tempRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "image");
  const timestamp = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
  await utimes(filePath, timestamp, timestamp);
  return filePath;
}

function runCleanup(overrides: Parameters<typeof runWebhookImagesCleanup>[0] = {}) {
  return runWebhookImagesCleanup({
    rootDir: tempRoot,
    now,
    retentionDays: 30,
    maxPerRun: 20_000,
    ...overrides,
  });
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "webhook-images-cleanup-"));
  env.webhookImagesCleanup.enabled = false;
  env.webhookImagesCleanup.cron = "30 4 * * *";
  mocks.schedule.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runWebhookImagesCleanup", () => {
  it("30 kundan eski faylni o'chiradi, yangisini qoldiradi", async () => {
    const oldFile = await writeImage("1/2026/09/18/10/overview.jpg", 31);
    const freshFile = await writeImage("1/2026/10/18/11/overview.jpg", 1);

    const result = await runCleanup();

    await expect(readFile(oldFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(freshFile)).resolves.toEqual(Buffer.from("image"));
    expect(result.deleted).toBe(1);
  });

  it("MAX_PER_RUN dan ortiq eski faylni bir yurishda o'chirmaydi", async () => {
    await writeImage("1/2026/09/18/10/one.jpg", 31);
    await writeImage("1/2026/09/18/10/two.jpg", 31);
    await writeImage("1/2026/09/18/10/three.jpg", 31);

    const result = await runCleanup({ maxPerRun: 2 });

    expect(result.deleted).toBe(2);
    const remaining = await Promise.all([
      readFile(path.join(tempRoot, "1/2026/09/18/10/one.jpg")).then(() => true).catch(() => false),
      readFile(path.join(tempRoot, "1/2026/09/18/10/two.jpg")).then(() => true).catch(() => false),
      readFile(path.join(tempRoot, "1/2026/09/18/10/three.jpg")).then(() => true).catch(() => false),
    ]);
    expect(remaining.filter(Boolean)).toHaveLength(1);
  });

  it("symlink va root tashqarisidagi faylni o'tkazib yuboradi", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "webhook-images-outside-"));
    const outsideFile = path.join(outsideRoot, "outside.jpg");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, path.join(tempRoot, "linked.jpg"));

    const result = await runCleanup();

    await expect(readFile(outsideFile)).resolves.toEqual(Buffer.from("outside"));
    expect(result.skipped.symlink).toBe(1);
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("sessiya ishora qilgan parking-events faylini o'chirmaydi", async () => {
    const protectedFile = await writeImage("1/2026/09/18/10/overview.jpg", 31);
    const protectedPath = "uploads/parking-events/1/2026/09/18/10/overview.jpg";

    const result = await runCleanup({
      findSessionReferencedPaths: async (paths) => new Set(paths.filter((value) => value === protectedPath)),
    });

    await expect(readFile(protectedFile)).resolves.toEqual(Buffer.from("image"));
    expect(result.skipped.sessionReference).toBe(1);
  });

  it("bitta fayl o'chirish xatosi qolgan fayllarni to'xtatmaydi", async () => {
    const failedFile = await writeImage("1/2026/09/18/10/failed.jpg", 31);
    const deletedFile = await writeImage("1/2026/09/18/10/deleted.jpg", 31);

    const result = await runCleanup({
      deleteFile: async (filePath) => {
        if (filePath === failedFile) throw new Error("unlink failed");
        await rm(filePath);
      },
    });

    await expect(readFile(failedFile)).resolves.toEqual(Buffer.from("image"));
    await expect(readFile(deletedFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(1);
  });
});

describe("scheduleWebhookImagesCleanupJob", () => {
  it("ENABLED=false bo'lsa cron ro'yxatdan o'tmaydi", () => {
    scheduleWebhookImagesCleanupJob();

    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});
