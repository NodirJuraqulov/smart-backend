import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entryManual, exitManual, getCapacity } from "@/modules/parking/parking.service";
import { updateCapacity } from "@/modules/organizations/organizations.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
  setOrgCapacity,
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
});

afterAll(async () => {
  await closeDb();
});

describe("updateCapacity", () => {
  it("org total_capacity'ni yangilaydi", async () => {
    const organization = await updateCapacity(orgId, 100);
    expect(organization.total_capacity).toBe(100);
  });

  it("null qiymatga qaytarish mumkin (cheksiz)", async () => {
    await updateCapacity(orgId, 50);
    const organization = await updateCapacity(orgId, null);
    expect(organization.total_capacity).toBeNull();
  });
});

describe("Sig'im (capacity) nazorati — kirish", () => {
  it("total_capacity=50, 50 ta faol sessiya bor holda — yangi kirish rad etiladi (parking_full)", async () => {
    await setOrgCapacity(orgId, 50);
    for (let i = 0; i < 50; i++) {
      await createTestActiveSession(orgId, `CAP-${i}`);
    }

    await expect(entryManual(operator, { plate_number: "NEW-CAR" })).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: "parking_full" },
    });
  });

  it("total_capacity=50, 49 ta faol — yangi kirish muvaffaqiyatli", async () => {
    await setOrgCapacity(orgId, 50);
    for (let i = 0; i < 49; i++) {
      await createTestActiveSession(orgId, `CAP-${i}`);
    }

    const session = await entryManual(operator, { plate_number: "NEW-CAR" });
    expect(session?.status).toBe("active");
  });

  it("total_capacity=null — hech qanday cheklov, har qancha mashina kirishi mumkin", async () => {
    await setOrgCapacity(orgId, null);
    for (let i = 0; i < 60; i++) {
      await createTestActiveSession(orgId, `CAP-${i}`);
    }

    const session = await entryManual(operator, { plate_number: "NEW-CAR" });
    expect(session?.status).toBe("active");
  });

  it("mashina chiqqanda — keyingi mashina uchun joy bo'shaydi", async () => {
    await setOrgCapacity(orgId, 1);
    await entryManual(operator, { plate_number: "FIRST-CAR" });

    await expect(entryManual(operator, { plate_number: "SECOND-CAR" })).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: "parking_full" },
    });

    await exitManual(operator, { plate_number: "FIRST-CAR" });

    const session = await entryManual(operator, { plate_number: "SECOND-CAR" });
    expect(session?.status).toBe("active");
  });
});

describe("getCapacity", () => {
  it("to'g'ri occupied/total/available qaytaradi", async () => {
    await setOrgCapacity(orgId, 50);
    for (let i = 0; i < 10; i++) {
      await createTestActiveSession(orgId, `CAP-${i}`);
    }

    const capacity = await getCapacity(operator);
    expect(capacity).toEqual({ occupied: 10, total: 50, available: 40 });
  });

  it("total_capacity=null bo'lsa — total va available null qaytaradi", async () => {
    const capacity = await getCapacity(operator);
    expect(capacity.total).toBeNull();
    expect(capacity.available).toBeNull();
  });
});
