import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import activityLogsRouter from "@/modules/activityLogs/activityLogs.routes";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import entryCandidatesRouter from "@/modules/entryCandidates/entryCandidates.routes";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import organizationsRouter from "@/modules/organizations/cameraRelaySettings.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import reportsRouter from "@/modules/reports/reports.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestAwaitingPaymentSession,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/parking", parkingRouter);
app.use("/api/entry-candidates", entryCandidatesRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/organizations", organizationsRouter);
app.use("/api/admin/activity-logs", activityLogsRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;

function authorization() {
  return `Bearer ${signAccessToken(owner)}`;
}

async function createWebhookEvent(direction: "entry" | "exit", plateNumber: string) {
  const [id] = await db("tb_webhook_events").insert({
    org_id: otherOrgId,
    plate_number: plateNumber,
    direction,
    camera_event_at: new Date(),
  });
  return id;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  const user = await createTestUser(orgId, { role: "owner" });
  owner = { id: user.id, org_id: orgId, role: "owner" };
});

afterEach(async () => {
  await cleanupOrganization(otherOrgId);
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("organization isolation audit", () => {
  it("parking sessions boshqa organization resursini yashiradi", async () => {
    const sessionId = await createTestActiveSession(otherOrgId, "01S100AA");

    const response = await request(app)
      .get(`/api/parking/sessions/${sessionId}`)
      .set("Authorization", authorization());

    expect(response.status).toBe(404);
  });

  it("payments boshqa organization sessiyasini o'zgartirishni bloklaydi", async () => {
    const sessionId = await createTestAwaitingPaymentSession(otherOrgId, "01P100AA");

    const response = await request(app)
      .post(`/api/parking/sessions/${sessionId}/confirm-cash-payment`)
      .set("Authorization", authorization());

    expect(response.status).toBe(404);
    expect(await db("tb_payments").where({ session_id: sessionId })).toHaveLength(0);
  });

  it("entry va exit candidates boshqa organization resurslarini yashiradi", async () => {
    const entryEventId = await createWebhookEvent("entry", "01C100AA");
    const exitEventId = await createWebhookEvent("exit", "01C101AA");
    const [entryCandidateId] = await db("tb_entry_candidates").insert({
      org_id: otherOrgId,
      webhook_event_id: entryEventId,
      detected_plate: "01C100AA",
      reason: "capacity_full",
      camera_event_at: new Date(),
    });
    const [exitCandidateId] = await db("tb_exit_candidates").insert({
      org_id: otherOrgId,
      webhook_event_id: exitEventId,
      detected_plate: "01C101AA",
      camera_event_at: new Date(),
    });

    const entryResponse = await request(app)
      .post(`/api/entry-candidates/${entryCandidateId}/decline`)
      .set("Authorization", authorization())
      .send({});
    const exitResponse = await request(app)
      .get(`/api/exit-candidates/${exitCandidateId}`)
      .set("Authorization", authorization());

    expect(entryResponse.status).toBe(404);
    expect(exitResponse.status).toBe(404);
  });

  it("reports so'rovdagi boshqa org_id qiymatini rad etadi", async () => {
    const response = await request(app)
      .get(`/api/reports/daily?org_id=${otherOrgId}`)
      .set("Authorization", authorization());

    expect(response.status).toBe(404);
  });

  it("camera relay settings boshqa organization resursini yashiradi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${otherOrgId}/camera-relay-settings`)
      .set("Authorization", authorization());

    expect(response.status).toBe(404);
  });

  it("activity logs boshqa organization egasi uchun yopiq qoladi", async () => {
    const response = await request(app)
      .get(`/api/admin/activity-logs?org_id=${otherOrgId}`)
      .set("Authorization", authorization());

    expect(response.status).toBe(403);
  });
});
