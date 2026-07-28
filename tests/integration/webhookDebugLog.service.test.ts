import { Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { logWebhookDebug } from "@/modules/webhook/webhookDebugLog.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

function buildFakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: { "content-type": "application/json" },
    query: {},
    body: Buffer.from(JSON.stringify({ hello: "world" })),
    ...overrides,
  } as unknown as Request;
}

let orgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

afterEach(async () => {
  if (orgId) {
    await cleanupOrganization(orgId);
  }
});

afterAll(async () => {
  await closeDb();
});

describe("logWebhookDebug", () => {
  it("to'g'ri org_id bilan haqiqatan DB'ga yozadi", async () => {
    orgId = await createTestOrganization();
    const req = buildFakeRequest();

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    expect(log).toBeTruthy();
    expect(log.headers).toBeTruthy();
    expect(log.body).toBeTruthy();
  });

  it("mavjud bo'lmagan org_id bilan xato TASHLAYDI, jim yutmaydi", async () => {
    const nonExistentOrgId = 999_999_999;
    const req = buildFakeRequest();

    await expect(logWebhookDebug(nonExistentOrgId, "entry", req)).rejects.toThrow();
  });

  it("juda katta body kesib (truncate) saqlanadi, insert baribir muvaffaqiyatli bo'ladi", async () => {
    orgId = await createTestOrganization();
    const hugeBody = Buffer.from("a".repeat(600_000));
    const req = buildFakeRequest({ body: hugeBody, headers: { "content-type": "text/plain" } });

    await logWebhookDebug(orgId, "exit", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "exit" });
    expect(log).toBeTruthy();
    const storedBody = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    expect(storedBody.body.length).toBeLessThan(600_000);
    expect(storedBody.body).toContain("truncated");
  });
});
