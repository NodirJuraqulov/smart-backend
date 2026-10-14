import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/config/env";
import { scheduleStaleSessionsCleanupJob } from "@/jobs/staleSessionsCleanupJob";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  run: vi.fn(),
}));

vi.mock("node-cron", () => ({ default: { schedule: mocks.schedule } }));

vi.mock("@/modules/maintenance/staleSessionsCleanup.service", () => ({
  runStaleSessionsCleanup: mocks.run,
}));

beforeEach(() => {
  env.staleSessionCleanup.enabled = false;
  env.staleSessionCleanup.cron = "30 3 * * *";
  mocks.schedule.mockReset();
  mocks.run.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  env.staleSessionCleanup.enabled = false;
  vi.restoreAllMocks();
});

describe("stale sessions cleanup job", () => {
  it("enabled false bo'lsa cron ro'yxatdan o'tmaydi", () => {
    scheduleStaleSessionsCleanupJob();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("enabled true bo'lsa configured cron bilan bir marta ro'yxatdan o'tadi", () => {
    env.staleSessionCleanup.enabled = true;
    env.staleSessionCleanup.cron = "5 4 * * *";
    scheduleStaleSessionsCleanupJob();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledWith("5 4 * * *", expect.any(Function));
  });

  it("callback service rejectionini yutadi va error log yozadi", async () => {
    env.staleSessionCleanup.enabled = true;
    const error = new Error("cleanup failed");
    mocks.run.mockRejectedValue(error);
    scheduleStaleSessionsCleanupJob();
    const callback = mocks.schedule.mock.calls[0][1] as () => Promise<void>;
    await expect(callback()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("STALE_SESSION_CLEANUP_FAILED", error);
  });
});
