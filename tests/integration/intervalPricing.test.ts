import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entryManual, exitManual } from "@/modules/parking/parking.service";
import {
  createTariffInterval,
  listTariffIntervals,
  updateTariffInterval,
} from "@/modules/tariffIntervals/tariffIntervals.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
  setOrgPricingMode,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await setOrgPricingMode(orgId, "interval");
  await createTariffInterval(orgId, { from_minutes: 5, to_minutes: 60, price: 10000 });
  await createTariffInterval(orgId, { from_minutes: 61, to_minutes: 600, price: 30000 });
  await createTariffInterval(orgId, { from_minutes: 601, to_minutes: null, price: 50000 });
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

describe("Interval (bosqichli) tarif rejimi", () => {
  it("entryManual'da tariff_intervals_snapshot saqlanadi, tariff_price_per_hour null qoladi", async () => {
    const session = await entryManual(operator, { plate_number: "01A100AA" });
    expect(session?.tariff_price_per_hour).toBeNull();
    expect(session?.tariff_intervals_snapshot).toBeTruthy();
  });

  it("4 daqiqa turgan mashina (birinchi interval'dan oldin) — amount 0", async () => {
    const plate = "01A101AA";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    await entryManual(operator, { plate_number: plate });

    vi.setSystemTime(new Date("2026-01-01T10:04:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(Number(result.session.amount)).toBe(0);
  });

  it("7 daqiqa turgan mashina — birinchi interval narxini oladi", async () => {
    const plate = "01A102AA";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    await entryManual(operator, { plate_number: plate });

    vi.setSystemTime(new Date("2026-01-01T10:07:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(Number(result.session.amount)).toBe(10000);
  });

  it("65 daqiqa turgan mashina — ikkinchi interval narxini oladi", async () => {
    const plate = "01A103AA";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    await entryManual(operator, { plate_number: plate });

    vi.setSystemTime(new Date("2026-01-01T11:05:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(Number(result.session.amount)).toBe(30000);
  });

  it("cheksiz oxirgi interval — 10 soatdan ko'p tursa ham bir xil narx", async () => {
    const plate = "01A104AA";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    await entryManual(operator, { plate_number: plate });

    vi.setSystemTime(new Date("2026-01-01T22:00:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(Number(result.session.amount)).toBe(50000);
  });

  it("tarif o'zgarsa (interval narxi tahrirlansa) — faol sessiyaga ta'sir qilmaydi (snapshot)", async () => {
    const plate = "01A105AA";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    await entryManual(operator, { plate_number: plate });

    const intervals = await listTariffIntervals(orgId);
    const first = intervals.find((i) => i.from_minutes === 5)!;
    await updateTariffInterval(orgId, first.id, { price: 99999 });

    vi.setSystemTime(new Date("2026-01-01T10:07:00.000Z"));
    const result = await exitManual(operator, { plate_number: plate });
    expect(Number(result.session.amount)).toBe(10000);
  });

  it("hourly rejimga qaytarilgan org — regressiyasiz hozirgidek ishlaydi", async () => {
    const plate = "01A106AA";
    await setOrgPricingMode(orgId, "hourly");

    await expect(entryManual(operator, { plate_number: plate })).rejects.toMatchObject({ statusCode: 400 });
  });
});
