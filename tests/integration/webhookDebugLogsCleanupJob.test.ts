import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { runWebhookDebugLogsCleanup } from "@/jobs/webhookDebugLogsCleanupJob";
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

async function insertDebugLog(receivedAt: Date): Promise<number> {
  const [id] = await db("tb_webhook_debug_logs").insert({
    org_id: orgId,
    direction: "entry",
    headers: JSON.stringify({}),
    body: JSON.stringify({}),
    received_at: receivedAt,
  });
  return id;
}

describe("runWebhookDebugLogsCleanup", () => {
  it("30 kundan eski yozuvlarni o'chiradi, yangilarini saqlab qoladi", async () => {
    const oldId = await insertDebugLog(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const freshId = await insertDebugLog(new Date(Date.now() - 24 * 60 * 60 * 1000));

    await runWebhookDebugLogsCleanup();

    const old = await db("tb_webhook_debug_logs").where({ id: oldId }).first();
    const fresh = await db("tb_webhook_debug_logs").where({ id: freshId }).first();

    expect(old).toBeUndefined();
    expect(fresh).toBeTruthy();
  });

  it("aynan 30 kundan yangi yozuvni saqlab qoladi", async () => {
    const id = await insertDebugLog(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

    await runWebhookDebugLogsCleanup();

    const log = await db("tb_webhook_debug_logs").where({ id }).first();
    expect(log).toBeTruthy();
  });
});
