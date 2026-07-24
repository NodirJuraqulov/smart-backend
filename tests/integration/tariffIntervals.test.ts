import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTariffInterval,
  deleteTariffInterval,
  listTariffIntervals,
  updateTariffInterval,
} from "@/modules/tariffIntervals/tariffIntervals.service";
import { updatePricingMode } from "@/modules/organizations/organizations.service";
import { ApiError } from "@/utils/ApiError";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariffInterval,
} from "./helpers";

let orgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("updatePricingMode", () => {
  it("org pricing_mode'ni 'interval'ga o'zgartiradi", async () => {
    const organization = await updatePricingMode(orgId, "interval");
    expect(organization.pricing_mode).toBe("interval");
  });

  it("mavjud bo'lmagan org uchun 404 xato", async () => {
    await expect(updatePricingMode(999999, "interval")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("createTariffInterval — ustma-ust tushish validatsiyasi", () => {
  it("ustma-ust tushmaydigan intervallar muvaffaqiyatli qo'shiladi", async () => {
    await createTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 10000 });
    const interval = await createTariffInterval(orgId, { from_minutes: 61, to_minutes: 120, price: 20000 });
    expect(interval?.from_minutes).toBe(61);
  });

  it("ustma-ust tushadigan interval qo'shishga urinish rad etiladi (400)", async () => {
    await createTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 10000 });

    await expect(
      createTariffInterval(orgId, { from_minutes: 30, to_minutes: 90, price: 20000 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("chegara nuqtasida ustma-ust tushish ham rad etiladi", async () => {
    await createTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 10000 });

    await expect(
      createTariffInterval(orgId, { from_minutes: 60, to_minutes: 120, price: 20000 })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("cheksiz (to_minutes: null) interval qo'shish mumkin", async () => {
    const interval = await createTariffInterval(orgId, { from_minutes: 601, to_minutes: null, price: 50000 });
    expect(interval?.to_minutes).toBeNull();
  });

  it("ikkinchi cheksiz interval avvalgisi bilan ustma-ust tushadi — rad etiladi", async () => {
    await createTariffInterval(orgId, { from_minutes: 601, to_minutes: null, price: 50000 });

    await expect(
      createTariffInterval(orgId, { from_minutes: 700, to_minutes: null, price: 70000 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("to_minutes from_minutes dan kichik yoki teng bo'lsa — rad etiladi", async () => {
    await expect(
      createTariffInterval(orgId, { from_minutes: 60, to_minutes: 60, price: 10000 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("updateTariffInterval", () => {
  it("boshqa interval bilan ustma-ust tushadigan tahrirlash rad etiladi", async () => {
    await createTestTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 10000 });
    const secondId = await createTestTariffInterval(orgId, { from_minutes: 61, to_minutes: 120, price: 20000 });

    await expect(updateTariffInterval(orgId, secondId, { from_minutes: 30 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("o'zi bilan taqqoslanmaydi — narxini tahrirlash muvaffaqiyatli", async () => {
    const id = await createTestTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 10000 });

    const updated = await updateTariffInterval(orgId, id, { price: 15000 });
    expect(Number(updated?.price)).toBe(15000);
  });

  it("mavjud bo'lmagan interval uchun 404 xato", async () => {
    await expect(updateTariffInterval(orgId, 999999, { price: 1 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("deleteTariffInterval", () => {
  it("interval o'chirilgach ro'yxatdan yo'qoladi", async () => {
    const id = await createTestTariffInterval(orgId);
    await deleteTariffInterval(orgId, id);

    const intervals = await listTariffIntervals(orgId);
    expect(intervals.find((i) => i.id === id)).toBeUndefined();
  });
});
