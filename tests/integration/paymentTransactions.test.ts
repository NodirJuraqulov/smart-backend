import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

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

describe("tb_payment_transactions — UNIQUE(provider, provider_transaction_id)", () => {
  it("bir xil provider + provider_transaction_id — ikkinchi yozuv rad etiladi", async () => {
    await db("tb_payment_transactions").insert({
      org_id: orgId,
      provider: "payme",
      provider_transaction_id: "TX-1",
      amount: 5000,
    });

    await expect(
      db("tb_payment_transactions").insert({
        org_id: orgId,
        provider: "payme",
        provider_transaction_id: "TX-1",
        amount: 7000,
      })
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("bir xil provider_transaction_id, LEKIN turli provider — ikkalasi ham qabul qilinadi", async () => {
    await db("tb_payment_transactions").insert({
      org_id: orgId,
      provider: "payme",
      provider_transaction_id: "TX-2",
      amount: 5000,
    });

    await expect(
      db("tb_payment_transactions").insert({
        org_id: orgId,
        provider: "click",
        provider_transaction_id: "TX-2",
        amount: 5000,
      })
    ).resolves.toBeDefined();
  });

  it("session_id null bo'lsa ham yozuv qabul qilinadi", async () => {
    await expect(
      db("tb_payment_transactions").insert({
        org_id: orgId,
        session_id: null,
        provider: "click",
        provider_transaction_id: "TX-3",
        amount: 12000,
      })
    ).resolves.toBeDefined();

    const [row] = await db("tb_payment_transactions").where({ org_id: orgId, provider_transaction_id: "TX-3" });
    expect(row.state).toBe("created");
    expect(row.session_id).toBeNull();
  });
});
