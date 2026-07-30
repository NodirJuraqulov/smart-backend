import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { clearWebhookDedupeCache, isDuplicateWebhookEvent } from "@/modules/webhook/webhookIdempotency";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

let orgId: number;
let otherOrgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
});

afterEach(async () => {
  await clearWebhookDedupeCache();
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(async () => {
  await closeDb();
});

describe("isDuplicateWebhookEvent", () => {
  it("birinchi hodisa uchun false qaytaradi", async () => {
    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "entry")).toBe(false);
  });

  it("10 soniya ichida takroriy hodisa uchun true qaytaradi", async () => {
    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "entry")).toBe(false);
    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "entry")).toBe(true);
  });

  it("boshqa org, plate yoki direction — mustaqil hisoblanadi", async () => {
    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "entry")).toBe(false);
    expect(await isDuplicateWebhookEvent(otherOrgId, "01A123AA", "entry")).toBe(false);
    expect(await isDuplicateWebhookEvent(orgId, "01A999AA", "entry")).toBe(false);
    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "exit")).toBe(false);
  });

  it("10 soniyadan keyin qaytadan false qaytaradi", async () => {
    await db("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: "01A123AA",
      direction: "entry",
      created_at: new Date(Date.now() - 30_000),
    });

    expect(await isDuplicateWebhookEvent(orgId, "01A123AA", "entry")).toBe(false);

    const events = await db("tb_webhook_events").where({ org_id: orgId, plate_number: "01A123AA" });
    expect(events).toHaveLength(2);
  });

  it("ikki bir vaqtda kelgan so'rovdan faqat bittasi false, ikkinchisi true qaytaradi", async () => {
    const [first, second] = await Promise.all([
      isDuplicateWebhookEvent(orgId, "01A555AA", "entry"),
      isDuplicateWebhookEvent(orgId, "01A555AA", "entry"),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r === false)).toHaveLength(1);
    expect(results.filter((r) => r === true)).toHaveLength(1);

    const events = await db("tb_webhook_events").where({ org_id: orgId, plate_number: "01A555AA" });
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.processing_result === "duplicate_same_direction")).toHaveLength(1);
  });
});
