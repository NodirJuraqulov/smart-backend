import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { entryManual, exitManual } from "@/modules/parking/parking.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestAwaitingPaymentSession,
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
  orgId = await createTestOrganization();
  await createTestTariff(orgId);
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

describe("entryManual — duplicate himoyasi", () => {
  it("bir xil nomer, hali chiqmagan holda — eski sessiya avtomatik yopiladi, yangisi ochiladi", async () => {
    const plate = "01A123AA";
    const first = await entryManual(operator, { plate_number: plate });

    const second = await entryManual(operator, { plate_number: plate });

    const closed = await db("tb_parking_sessions").where({ id: first!.id }).first();
    expect(closed).toMatchObject({
      status: "completed",
      exit_method: "auto_closed_on_reentry",
      active_plate_key: null,
    });
    expect(Number(closed.amount)).toBe(0);
    expect(await db("tb_payments").where({ session_id: first!.id })).toHaveLength(0);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.status).toBe("active");
  });

  it("to'lov kutayotgan sessiya uchun kirish hamon ApiError 409 bilan rad etiladi", async () => {
    const plate = "01A124AA";
    const awaitingId = await createTestAwaitingPaymentSession(orgId, plate);

    await expect(entryManual(operator, { plate_number: plate })).rejects.toBeInstanceOf(ApiError);
    await expect(entryManual(operator, { plate_number: plate })).rejects.toMatchObject({
      statusCode: 409,
    });
    const untouched = await db("tb_parking_sessions").where({ id: awaitingId }).first();
    expect(untouched.status).toBe("awaiting_payment");
  });

  it("bir xil nomer, chiqqandan keyin — YANGI kirish RUXSAT etiladi", async () => {
    const plate = "01A125AA";
    const first = await entryManual(operator, { plate_number: plate });

    await exitManual(operator, { plate_number: plate });

    const second = await entryManual(operator, { plate_number: plate });
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.status).toBe("active");
  });

  it("boshqa nomer bilan parallel faol sessiya — muammosiz ruxsat etiladi", async () => {
    await entryManual(operator, { plate_number: "01A200AA" });
    const other = await entryManual(operator, { plate_number: "01A201AA" });
    expect(other).toBeTruthy();
  });
});
