import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { createTariff, updateTariff } from "@/modules/tariffs/tariffs.service";
import { createOrganization } from "@/modules/organizations/organizations.service";
import { ApiError } from "@/utils/ApiError";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("createTariff — yagona tarif cheklovi", () => {
  it("org uchun tarif allaqachon mavjud bo'lsa — 400 xato", async () => {
    await createTestTariff(orgId);

    await expect(createTariff(operator, { name: "Yangi", price_per_hour: 8000 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("400 xatosi ApiError instansiyasi bo'lishi kerak", async () => {
    await createTestTariff(orgId);

    await expect(createTariff(operator, { name: "Yangi", price_per_hour: 8000 })).rejects.toBeInstanceOf(
      ApiError
    );
  });

  it("org uchun hali tarif yo'q bo'lsa — birinchi tarif muvaffaqiyatli yaratiladi", async () => {
    const tariff = await createTariff(operator, { name: "Standart", price_per_hour: 5000 });
    expect(tariff?.org_id).toBe(orgId);
  });
});

describe("updateTariff", () => {
  it("operator mavjud tarifni tahrirlay oladi — hozirgidek", async () => {
    const tariffId = await createTestTariff(orgId, { price_per_hour: 5000 });

    const updated = await updateTariff(operator, tariffId, { price_per_hour: 7000 });

    expect(Number(updated?.price_per_hour)).toBe(7000);
  });

  it("owner mavjud tarifni tahrirlay oladi", async () => {
    const ownerUser = await createTestUser(orgId, { role: "owner" });
    const owner: AuthTokenPayload = { id: ownerUser.id, org_id: orgId, role: "owner" };
    const tariffId = await createTestTariff(orgId, { price_per_hour: 5000 });

    const updated = await updateTariff(owner, tariffId, { price_per_hour: 6000 });

    expect(Number(updated?.price_per_hour)).toBe(6000);
  });

  it("super_admin istalgan org'ning tarifini tahrirlay oladi — scope tekshiruvisiz", async () => {
    const tariffId = await createTestTariff(orgId, { price_per_hour: 5000 });

    const updated = await updateTariff(superAdmin, tariffId, { price_per_hour: 9000 });

    expect(Number(updated?.price_per_hour)).toBe(9000);
  });

  it("boshqa org operatori tahrirlashga urinsa — 404 xato", async () => {
    const tariffId = await createTestTariff(orgId);
    const otherOrgId = await createTestOrganization();

    try {
      const otherOperatorUser = await createTestUser(otherOrgId, { role: "operator" });
      const otherOperator: AuthTokenPayload = {
        id: otherOperatorUser.id,
        org_id: otherOrgId,
        role: "operator",
      };

      await expect(updateTariff(otherOperator, tariffId, { price_per_hour: 9000 })).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });

  it("boshqa org egasi (owner) tahrirlashga urinsa — 404 xato", async () => {
    const tariffId = await createTestTariff(orgId);
    const otherOrgId = await createTestOrganization();

    try {
      const otherOwnerUser = await createTestUser(otherOrgId, { role: "owner" });
      const otherOwner: AuthTokenPayload = {
        id: otherOwnerUser.id,
        org_id: otherOrgId,
        role: "owner",
      };

      await expect(updateTariff(otherOwner, tariffId, { price_per_hour: 9000 })).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });
});

describe("stoyanka yaratish oqimi — boshlang'ich tarif regressiyasi yo'q", () => {
  it("yangi org yaratilgach, unga birinchi tarif avtomatik yaratiladi", async () => {
    const result = await createOrganization({
      name: `Yangi Stoyanka ${Date.now()}`,
      owner: {
        name: "Test Owner",
        login: `wizard_owner_${Date.now()}`,
        password: "parol12345",
      },
      tariff: { price_per_hour: 5000 },
    });

    const newOrgId = result.organization!.id;

    try {
      expect(result.tariff?.org_id).toBe(newOrgId);
      expect(Number(result.tariff?.price_per_hour)).toBe(5000);

      await expect(createTariff(superAdmin, { org_id: newOrgId, name: "Yana", price_per_hour: 9000 })).rejects.toMatchObject({
        statusCode: 400,
      });
    } finally {
      await cleanupOrganization(newOrgId);
    }
  });
});
