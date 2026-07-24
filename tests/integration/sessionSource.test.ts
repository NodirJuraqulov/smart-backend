import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entryManual, exitManual } from "@/modules/parking/parking.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
  createTestSubscription,
  createTestTariff,
  createTestUser,
  createTestVipVehicle,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
  await createTestSettings(orgId, { work_hours_enabled: false });
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

describe("VIP mashina", () => {
  it("kirib-chiqishida amount:0, session_source:'vip'", async () => {
    const plate = "01D100AA";
    await createTestVipVehicle(orgId, plate);

    const session = await entryManual(operator, { plate_number: plate });
    expect(session?.session_source).toBe("vip");
    expect(session?.tariff_price_per_hour).toBeNull();

    const result = await exitManual(operator, { plate_number: plate });
    expect(result.session.amount).toBe("0");
    expect(result.session.session_source).toBe("vip");
  });
});

describe("Obunachi mashina", () => {
  it("faol obuna bilan kirib-chiqishida amount:0, session_source:'subscription'", async () => {
    const plate = "01D200AA";
    const endDate = DateTime.now().plus({ days: 10 }).toFormat("yyyy-MM-dd");
    await createTestSubscription(orgId, plate, { end_date: endDate });

    const session = await entryManual(operator, { plate_number: plate });
    expect(session?.session_source).toBe("subscription");
    expect(session?.tariff_price_per_hour).toBeNull();

    const result = await exitManual(operator, { plate_number: plate });
    expect(result.session.amount).toBe("0");
    expect(result.session.session_source).toBe("subscription");
  });

  it("obuna muddati tugagan bo'lsa — oddiy (to'lovli) rejimga qaytadi", async () => {
    const plate = "01D300AA";
    await createTestSubscription(orgId, plate, { end_date: "2026-01-01" });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-05T10:00:00.000Z"));
    const session = await entryManual(operator, { plate_number: plate });
    expect(session?.session_source).toBe("regular");
    expect(session?.tariff_price_per_hour).not.toBeNull();

    vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(result.session.session_source).toBe("regular");
    expect(Number(result.session.amount)).toBe(10000);
  });
});
