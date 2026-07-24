import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entryManual } from "@/modules/parking/parking.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  await createTestTariff(orgId);
  const user = await createTestUser(orgId);
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb();
});

describe("assertWithinWorkHours — entryManual orqali", () => {
  it("ish vaqti ichida — ruxsat etiladi", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
    await createTestSettings(orgId, { work_hours_enabled: true, work_start: "09:00", work_end: "18:00" });

    await expect(entryManual(operator, { plate_number: "01B100AA" })).resolves.toBeTruthy();
  });

  it("ish vaqti tashqarisida — rad etiladi (403)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T20:00:00.000Z"));
    await createTestSettings(orgId, { work_hours_enabled: true, work_start: "09:00", work_end: "18:00" });

    await expect(entryManual(operator, { plate_number: "01B101AA" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("tungi (kesib o'tuvchi) ish vaqti oralig'ida — ruxsat etiladi", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T23:30:00.000Z"));
    await createTestSettings(orgId, { work_hours_enabled: true, work_start: "22:00", work_end: "06:00" });

    await expect(entryManual(operator, { plate_number: "01B102AA" })).resolves.toBeTruthy();
  });

  it("tungi (kesib o'tuvchi) ish vaqtidan tashqarida — rad etiladi (403)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
    await createTestSettings(orgId, { work_hours_enabled: true, work_start: "22:00", work_end: "06:00" });

    await expect(entryManual(operator, { plate_number: "01B103AA" })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("ish vaqti tekshiruvi o'chirilgan bo'lsa — cheklovsiz, istalgan vaqtda ruxsat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T20:00:00.000Z"));
    await createTestSettings(orgId, { work_hours_enabled: false, work_start: "09:00", work_end: "18:00" });

    await expect(entryManual(operator, { plate_number: "01B104AA" })).resolves.toBeTruthy();
  });

  it("settings qatori umuman mavjud bo'lmasa — cheklovsiz ruxsat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T20:00:00.000Z"));

    await expect(entryManual(operator, { plate_number: "01B105AA" })).resolves.toBeTruthy();
  });
});
