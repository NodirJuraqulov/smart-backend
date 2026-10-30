import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { runWebhookEventsCleanup } from "@/jobs/webhookEventsCleanupJob";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

let orgId: number;
let actorId: number;

async function createResolvedCandidate(input: {
  resolutionType: "exit_cancelled" | "forced_open" | "emergency_forced_open" | "exact";
  resolvedDaysAgo: number;
}): Promise<{ candidateId: number; eventId: number }> {
  const timestamp = new Date(Date.now() - input.resolvedDaysAgo * 24 * 60 * 60 * 1000);
  const [eventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: "01C100AA",
    direction: "exit",
    camera_event_at: timestamp,
    overview_image_path: `uploads/parking-events/${orgId}/2026/10/01/${Date.now()}/overview.jpg`,
    created_at: timestamp,
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: eventId,
    detected_plate: "01C100AA",
    camera_event_at: timestamp,
    status: "dismissed",
    resolution_type: input.resolutionType,
    resolved_by: actorId,
    resolved_at: timestamp,
  });
  return { candidateId, eventId };
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  env.cancelledExitRetentionDays = 30;
  env.forcedOpenRetentionDays = 4;
  orgId = await createTestOrganization();
  actorId = (await createTestUser(orgId, { role: "operator" })).id;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.restoreAllMocks();
});

afterAll(closeDb);

describe("webhook events cleanup", () => {
  it("retention ichidagi exit_cancelled webhook va nomzodni saqlaydi", async () => {
    const record = await createResolvedCandidate({ resolutionType: "exit_cancelled", resolvedDaysAgo: 10 });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeDefined();
    expect(await db("tb_exit_candidates").where({ id: record.candidateId }).first()).toBeDefined();
  });

  it("retention muddati o'tgan exit_cancelled webhookni mavjud qoida bo'yicha o'chiradi", async () => {
    const record = await createResolvedCandidate({ resolutionType: "exit_cancelled", resolvedDaysAgo: 31 });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeUndefined();
    expect(await db("tb_exit_candidates").where({ id: record.candidateId }).first()).toBeUndefined();
  });

  it.each(["forced_open", "emergency_forced_open"] as const)(
    "%s webhookini 24 soatdan keyin ham to'rt kun saqlaydi",
    async (resolutionType) => {
      const record = await createResolvedCandidate({ resolutionType, resolvedDaysAgo: 2 });

      await runWebhookEventsCleanup();

      expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeDefined();
      expect(await db("tb_exit_candidates").where({ id: record.candidateId }).first()).toBeDefined();
    }
  );

  it("to'rt kundan o'tgan majburiy ochish webhookini mavjud qoida bo'yicha o'chiradi", async () => {
    const record = await createResolvedCandidate({ resolutionType: "forced_open", resolvedDaysAgo: 5 });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeUndefined();
    expect(await db("tb_exit_candidates").where({ id: record.candidateId }).first()).toBeUndefined();
  });

  it("boshqa resolution_type uchun 24 soatlik cleanupni o'zgartirmaydi", async () => {
    const record = await createResolvedCandidate({ resolutionType: "exact", resolvedDaysAgo: 2 });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeUndefined();
    expect(await db("tb_exit_candidates").where({ id: record.candidateId }).first()).toBeUndefined();
  });

  it("saqlangan review webhookini retention muddati o'tsa ham o'chirmaydi", async () => {
    const record = await createResolvedCandidate({ resolutionType: "forced_open", resolvedDaysAgo: 10 });
    await db("forced_open_reviews").insert({
      org_id: orgId,
      candidate_id: record.candidateId,
      operator_id: actorId,
      operator_name: "Test Operator",
      forced_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      webhook_event_id: record.eventId,
      amount_som: 10000,
      kind: "not_found",
      saved_by: actorId,
    });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: record.eventId }).first()).toBeDefined();
    expect(await db("forced_open_reviews").where({ candidate_id: record.candidateId }).first()).toBeDefined();
  });

  it("env retention qiymatini ishlatadi", async () => {
    env.cancelledExitRetentionDays = 5;
    const protectedRecord = await createResolvedCandidate({ resolutionType: "exit_cancelled", resolvedDaysAgo: 4 });
    const expiredRecord = await createResolvedCandidate({ resolutionType: "exit_cancelled", resolvedDaysAgo: 6 });

    await runWebhookEventsCleanup();

    expect(await db("tb_webhook_events").where({ id: protectedRecord.eventId }).first()).toBeDefined();
    expect(await db("tb_webhook_events").where({ id: expiredRecord.eventId }).first()).toBeUndefined();
  });
});
