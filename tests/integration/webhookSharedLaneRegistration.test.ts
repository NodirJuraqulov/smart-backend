import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import {
  clearWebhookDedupeCache,
  registerWebhookEvent,
} from "@/modules/webhook/webhookIdempotency";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
} from "./helpers";

let orgId: number;

async function insertPreviousEvent(input: {
  plateNumber: string;
  direction?: "entry" | "exit";
  createdSecondsAgo: number;
  cameraSecondsAgo?: number | null;
  processingResult?: string | null;
  processedAt?: Date | null;
}) {
  await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: input.plateNumber,
    direction: input.direction ?? "entry",
    created_at: new Date(Date.now() - input.createdSecondsAgo * 1000),
    camera_event_at:
      input.cameraSecondsAgo === undefined || input.cameraSecondsAgo === null
        ? null
        : new Date(Date.now() - input.cameraSecondsAgo * 1000),
    processing_result: input.processingResult ?? null,
    processed_at: input.processedAt ?? null,
  });
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  await db("tb_organizations").where({ id: orgId }).update({
    gate_layout: "shared",
    cross_camera_guard_seconds: 90,
  });
});

afterEach(async () => {
  await clearWebhookDedupeCache(orgId);
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("shared-lane webhook registration", () => {
  it.each([2, 89])("exact opposite event %i soniyada ignored bo'ladi", async (secondsAgo) => {
    await insertPreviousEvent({
      plateNumber: "01A123BC",
      createdSecondsAgo: secondsAgo,
      cameraSecondsAgo: secondsAgo,
      processingResult: "entry_created",
    });

    const result = await registerWebhookEvent(orgId, "01A123BC", "exit", {
      cameraEventAt: new Date(),
    });

    expect(result).toMatchObject({
      status: "opposite_camera_echo",
      firstDirection: "entry",
    });
    if (result.status === "opposite_camera_echo") {
      expect(result.deltaSeconds).toBeGreaterThanOrEqual(secondsAgo - 1);
      expect(result.deltaSeconds).toBeLessThanOrEqual(secondsAgo + 1);
    }
  });

  it("exact opposite event 91 soniyadan keyin accepted bo'ladi", async () => {
    await insertPreviousEvent({
      plateNumber: "01A123BC",
      createdSecondsAgo: 91,
      cameraSecondsAgo: 91,
      processingResult: "entry_created",
    });

    const result = await registerWebhookEvent(orgId, "01A123BC", "exit", {
      cameraEventAt: new Date(),
    });

    expect(result.status).toBe("accepted");
  });

  it("processed_at NULL bo'lgan birinchi event ham opposite eventni bloklaydi", async () => {
    await insertPreviousEvent({
      plateNumber: "01A124BC",
      createdSecondsAgo: 3,
      cameraSecondsAgo: 3,
      processingResult: null,
      processedAt: null,
    });

    const result = await registerWebhookEvent(orgId, "01A124BC", "exit");

    expect(result.status).toBe("opposite_camera_echo");
  });

  it.each([
    "entry_rejected",
    "active_entry_already_exists",
    "unmatched_exit",
  ])("parking natijasi %s bo'lgan fizik event ham guard anchor bo'ladi", async (processingResult) => {
    await insertPreviousEvent({
      plateNumber: "01A130BC",
      createdSecondsAgo: 4,
      processingResult,
      processedAt: null,
    });

    const result = await registerWebhookEvent(orgId, "01A130BC", "exit");

    expect(result.status).toBe("opposite_camera_echo");
  });

  it("simultaneous opposite registrationlardan faqat bittasi accepted bo'ladi", async () => {
    const [entry, exit] = await Promise.all([
      registerWebhookEvent(orgId, "01A125BC", "entry"),
      registerWebhookEvent(orgId, "01A125BC", "exit"),
    ]);

    expect([entry.status, exit.status].filter((status) => status === "accepted")).toHaveLength(1);
    expect(
      [entry.status, exit.status].filter((status) => status === "opposite_camera_echo")
    ).toHaveLength(1);
  });

  it.each([
    ["01C914AD", "C914AD"],
    ["01C914AD", "01C915AD"],
  ])("%s va %s near-plate conflict bo'ladi", async (firstPlate, currentPlate) => {
    await insertPreviousEvent({
      plateNumber: firstPlate,
      createdSecondsAgo: 73,
      cameraSecondsAgo: 73,
      processingResult: "entry_created",
    });

    const result = await registerWebhookEvent(orgId, currentPlate, "exit", {
      cameraEventAt: new Date(),
    });

    expect(result).toMatchObject({
      status: "shared_lane_conflict",
      firstPlateNumber: firstPlate,
    });
    if (result.status === "shared_lane_conflict") {
      expect(result.deltaSeconds).toBeGreaterThanOrEqual(72);
      expect(result.deltaSeconds).toBeLessThanOrEqual(74);
    }
  });

  it("valid camera_event_at server created_at'dan farqli guard qarorini beradi", async () => {
    await insertPreviousEvent({
      plateNumber: "01A126BC",
      createdSecondsAgo: 100,
      cameraSecondsAgo: 89,
      processingResult: "entry_created",
    });

    const result = await registerWebhookEvent(orgId, "01A126BC", "exit", {
      cameraEventAt: new Date(),
    });

    expect(result.status).toBe("opposite_camera_echo");
    if (result.status === "opposite_camera_echo") {
      expect(result.deltaSeconds).toBeGreaterThanOrEqual(88);
      expect(result.deltaSeconds).toBeLessThanOrEqual(90);
    }
  });

  it.each([
    new Date(Date.now() - 24 * 60 * 60 * 1000),
    new Date(Date.now() + 24 * 60 * 60 * 1000),
    new Date(Number.NaN),
  ])("stale/future/invalid camera time created_at fallback ishlatadi", async (cameraEventAt) => {
    await insertPreviousEvent({
      plateNumber: "01A127BC",
      createdSecondsAgo: 2,
      cameraSecondsAgo: null,
      processingResult: "entry_created",
    });
    await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "01A127BC" })
      .update({ camera_event_at: Number.isFinite(cameraEventAt.getTime()) ? cameraEventAt : null });

    const result = await registerWebhookEvent(orgId, "01A127BC", "exit", {
      cameraEventAt: new Date(),
    });

    expect(result.status).toBe("opposite_camera_echo");
    if (result.status === "opposite_camera_echo") {
      expect(result.deltaSeconds).toBeGreaterThanOrEqual(1);
      expect(result.deltaSeconds).toBeLessThanOrEqual(3);
    }
  });

  it("duplicate audit qatorlari dedupe oynasini uzaytirmaydi", async () => {
    const first = await registerWebhookEvent(orgId, "01A128BC", "entry");
    const duplicate = await registerWebhookEvent(orgId, "01A128BC", "entry");
    expect(first.status).toBe("accepted");
    expect(duplicate.status).toBe("same_direction_duplicate");

    await db("tb_webhook_events")
      .where({ id: first.eventId })
      .update({ created_at: new Date(Date.now() - 30_000) });

    const afterWindow = await registerWebhookEvent(orgId, "01A128BC", "entry");
    expect(afterWindow.status).toBe("accepted");
  });

  it("separate layout opposite eventlarni bostirmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ gate_layout: "separate" });
    await insertPreviousEvent({
      plateNumber: "01A129BC",
      createdSecondsAgo: 2,
      processingResult: "entry_created",
    });

    const result = await registerWebhookEvent(orgId, "01A129BC", "exit");

    expect(result.status).toBe("accepted");
  });
});
