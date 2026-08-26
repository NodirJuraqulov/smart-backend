import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import forcedOpenHistoryRouter from "@/modules/exitCandidates/forcedOpenHistory.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/organizations", forcedOpenHistoryRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let kassir: AuthTokenPayload;
let operator: AuthTokenPayload;
let otherOwner: AuthTokenPayload;
let superAdmin: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createEvent(plateNumber: string, occurredAt: Date, imageKind: "overview" | "vehicle") {
  const [id] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plateNumber,
    direction: "exit",
    camera_event_at: occurredAt,
    [`${imageKind}_image_path`]: `uploads/parking-events/${orgId}/${plateNumber}.jpg`,
  });
  return id;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const kassirUser = await createTestUser(orgId, { role: "kassir" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const otherOwnerUser = await createTestUser(otherOrgId, { role: "owner" });
  const superAdminUser = await createTestUser(null, { role: "super_admin" });

  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  kassir = { id: kassirUser.id, org_id: orgId, role: "kassir" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  otherOwner = { id: otherOwnerUser.id, org_id: otherOrgId, role: "owner" };
  superAdmin = { id: superAdminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await db("tb_users").where({ id: superAdmin.id }).del();
});

afterAll(closeDb);

describe("GET /api/organizations/:id/emergency-exit-history", () => {
  it("confirm va force-open emergency yozuvlarini birlashtirib qaytaradi", async () => {
    const confirmedAt = new Date("2026-08-25T08:30:00.000Z");
    const forcedAt = new Date("2026-08-25T08:31:00.000Z");
    const sessionId = await createTestActiveSession(orgId, "01E100AA");
    await db("tb_parking_sessions").where({ id: sessionId }).update({
      status: "completed",
      exited_at: confirmedAt,
      duration_minutes: 30,
      amount: 0,
      exit_method: "emergency",
      operator_id: operator.id,
      active_plate_key: null,
    });

    const confirmedEventId = await createEvent("01E100AA", confirmedAt, "overview");
    const [confirmedCandidateId] = await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: confirmedEventId,
      detected_plate: "01E100AA",
      confidence: 96,
      camera_event_at: confirmedAt,
      status: "accepted",
      resolution_type: "emergency_confirmed",
      resolved_session_id: sessionId,
      resolved_by: operator.id,
      resolved_at: confirmedAt,
    });

    const forcedEventId = await createEvent("01E200AA", forcedAt, "vehicle");
    const [forcedCandidateId] = await db("tb_exit_candidates").insert({
      org_id: orgId,
      webhook_event_id: forcedEventId,
      detected_plate: "01E200AA",
      confidence: 90,
      camera_event_at: forcedAt,
      status: "dismissed",
      resolution_type: "emergency_forced_open",
      resolved_session_id: null,
      resolved_by: operator.id,
      resolved_at: forcedAt,
      resolution_note: "emergency: 103 chaqiruvi",
    });

    for (const actor of [owner, kassir, superAdmin]) {
      const response = await request(app)
        .get(`/api/organizations/${orgId}/emergency-exit-history`)
        .set("Authorization", authorization(actor));

      expect(response.status).toBe(200);
      expect(response.body.history).toEqual([
        {
          id: `candidate:${forcedCandidateId}`,
          source: "exit_candidate",
          session_id: null,
          candidate_id: forcedCandidateId,
          plate_number: "01E200AA",
          occurred_at: forcedAt.toISOString(),
          confirmed_by: { id: operator.id, name: "Test User" },
          type: "forced_open",
          resolution_note: "emergency: 103 chaqiruvi",
          image_url: `/api/webhook-events/${forcedEventId}/images/vehicle`,
        },
        {
          id: `session:${sessionId}`,
          source: "parking_session",
          session_id: sessionId,
          candidate_id: confirmedCandidateId,
          plate_number: "01E100AA",
          occurred_at: confirmedAt.toISOString(),
          confirmed_by: { id: operator.id, name: "Test User" },
          type: "confirmed",
          resolution_note: null,
          image_url: `/api/webhook-events/${confirmedEventId}/images/overview`,
        },
      ]);
      expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 2, total_pages: 1 });
    }
  });

  it("sahifalash va rollar bo'yicha kirishni tekshiradi", async () => {
    const firstAt = new Date("2026-08-25T08:30:00.000Z");
    const secondAt = new Date("2026-08-25T08:31:00.000Z");
    for (const [plateNumber, occurredAt] of [
      ["01E300AA", firstAt],
      ["01E400AA", secondAt],
    ] as const) {
      const eventId = await createEvent(plateNumber, occurredAt, "overview");
      await db("tb_exit_candidates").insert({
        org_id: orgId,
        webhook_event_id: eventId,
        detected_plate: plateNumber,
        confidence: 90,
        camera_event_at: occurredAt,
        status: "dismissed",
        resolution_type: "emergency_forced_open",
        resolved_by: operator.id,
        resolved_at: occurredAt,
      });
    }

    const page = await request(app)
      .get(`/api/organizations/${orgId}/emergency-exit-history?page=2&limit=1`)
      .set("Authorization", authorization(owner));
    const operatorResponse = await request(app)
      .get(`/api/organizations/${orgId}/emergency-exit-history`)
      .set("Authorization", authorization(operator));
    const foreignResponse = await request(app)
      .get(`/api/organizations/${orgId}/emergency-exit-history`)
      .set("Authorization", authorization(otherOwner));

    expect(page.status).toBe(200);
    expect(page.body.history).toHaveLength(1);
    expect(page.body.history[0].plate_number).toBe("01E300AA");
    expect(page.body.pagination).toEqual({ page: 2, limit: 1, total: 2, total_pages: 2 });
    expect(operatorResponse.status).toBe(403);
    expect(foreignResponse.status).toBe(404);
  });
});
