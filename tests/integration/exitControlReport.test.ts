import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import reportsRouter from "@/modules/reports/reports.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestUser,
  seedTestOperatorPermissions,
} from "./helpers";

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let operator: AuthTokenPayload;
const globalUserIds: number[] = [];

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/reports", reportsRouter);
  instance.use(errorHandler);
  return instance;
}

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createSession(source: "regular" | "vip" | "subscription"): Promise<number> {
  const id = await createTestActiveSession(orgId, `01R${Date.now()}${Math.random()}`.slice(0, 20));
  await db("tb_parking_sessions").where({ id }).update({ session_source: source });
  return id;
}

async function createCandidate(input: {
  cameraEventAt: string;
  resolutionType?: "emergency_forced_open" | "forced_open";
  matchedSessionId?: number | null;
  resolvedSessionId?: number | null;
}): Promise<void> {
  const [webhookEventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    direction: "exit",
    camera_event_at: new Date(input.cameraEventAt),
  });
  await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: webhookEventId,
    detected_plate: null,
    matched_session_id: input.matchedSessionId ?? null,
    resolved_session_id: input.resolvedSessionId ?? null,
    camera_event_at: new Date(input.cameraEventAt),
    status: input.resolutionType ? "dismissed" : "pending",
    resolution_type: input.resolutionType ?? null,
    resolved_at: input.resolutionType ? new Date(input.cameraEventAt) : null,
  });
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  env.forcedOpenAvgLossSom = 10000;
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  await seedTestOperatorPermissions(orgId);
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  env.forcedOpenAvgLossSom = 10000;
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  if (globalUserIds.length > 0) {
    await db("tb_users").whereIn("id", globalUserIds.splice(0)).del();
  }
});

afterAll(closeDb);

describe("GET /api/reports/exit-control", () => {
  it("aniq kontrakt, COALESCE tasnifi, bo'sh kunlar va totalsni qaytaradi", async () => {
    const regularSessionId = await createSession("regular");
    const vipSessionId = await createSession("vip");
    const subscriptionSessionId = await createSession("subscription");
    const localDay = "2026-10-13T06:00:00Z";
    await createCandidate({ cameraEventAt: localDay });
    await createCandidate({ cameraEventAt: localDay, resolutionType: "emergency_forced_open" });
    await createCandidate({
      cameraEventAt: localDay,
      resolutionType: "emergency_forced_open",
      matchedSessionId: regularSessionId,
    });
    await createCandidate({
      cameraEventAt: localDay,
      resolutionType: "emergency_forced_open",
      matchedSessionId: vipSessionId,
    });
    await createCandidate({
      cameraEventAt: localDay,
      resolutionType: "emergency_forced_open",
      matchedSessionId: regularSessionId,
      resolvedSessionId: subscriptionSessionId,
    });
    await createCandidate({ cameraEventAt: localDay, resolutionType: "forced_open" });
    await createCandidate({ cameraEventAt: localDay, resolvedSessionId: regularSessionId });

    const response = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-14")
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual([
      "estimated",
      "avg_loss_som",
      "from",
      "to",
      "days",
      "totals",
    ]);
    expect(response.body).toEqual({
      estimated: true,
      avg_loss_som: 10000,
      from: "2026-10-13",
      to: "2026-10-14",
      days: [
        {
          date: "2026-10-13",
          not_found_count: 3,
          forced_open_count: 4,
          forced_open_unknown_or_regular: 2,
          forced_open_vip_or_subscription: 2,
          estimated_loss_som: 20000,
        },
        {
          date: "2026-10-14",
          not_found_count: 0,
          forced_open_count: 0,
          forced_open_unknown_or_regular: 0,
          forced_open_vip_or_subscription: 0,
          estimated_loss_som: 0,
        },
      ],
      totals: {
        not_found_count: 3,
        forced_open_count: 4,
        forced_open_unknown_or_regular: 2,
        forced_open_vip_or_subscription: 2,
        estimated_loss_som: 20000,
      },
    });
  });

  it("camera_event_at ni organization vaqt zonasidagi kunga ajratadi", async () => {
    await createCandidate({
      cameraEventAt: "2026-10-13T19:30:00Z",
      resolutionType: "emergency_forced_open",
    });
    const response = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-14")
      .set("Authorization", authorization(owner));
    expect(response.status).toBe(200);
    expect(response.body.days[0].forced_open_count).toBe(0);
    expect(response.body.days[1]).toMatchObject({
      date: "2026-10-14",
      not_found_count: 1,
      forced_open_count: 1,
      estimated_loss_som: 10000,
    });
  });

  it("93 kunni qabul qiladi, 94 kun va noto'g'ri querylarni 400 qiladi", async () => {
    const accepted = await request(app())
      .get("/api/reports/exit-control?from=2026-01-01&to=2026-04-03")
      .set("Authorization", authorization(owner));
    expect(accepted.status).toBe(200);
    expect(accepted.body.days).toHaveLength(93);

    for (const query of [
      "from=2026-01-01&to=2026-04-04",
      "from=2026-10-13",
      "to=2026-10-13",
      "from=2026-02-30&to=2026-03-01",
      "from=2026-10-14&to=2026-10-13",
    ]) {
      const response = await request(app())
        .get(`/api/reports/exit-control?${query}`)
        .set("Authorization", authorization(owner));
      expect(response.status).toBe(400);
    }
  });

  it("owner, reports operator va Super Admin uchun ruxsat beradi", async () => {
    const ownerResponse = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-13")
      .set("Authorization", authorization(owner));
    const operatorResponse = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-13")
      .set("Authorization", authorization(operator));
    const adminUser = await createTestUser(null, { role: "super_admin" });
    globalUserIds.push(adminUser.id);
    const admin: AuthTokenPayload = { id: adminUser.id, org_id: null, role: "super_admin" };
    const adminResponse = await request(app())
      .get(`/api/reports/exit-control?from=2026-10-13&to=2026-10-13&org_id=${orgId}`)
      .set("Authorization", authorization(admin));
    expect(ownerResponse.status).toBe(200);
    expect(operatorResponse.status).toBe(200);
    expect(adminResponse.status).toBe(200);
  });

  it("operator boshqa organizationni so'rasa 404, permission bo'lmasa 403", async () => {
    const otherOrgResponse = await request(app())
      .get(`/api/reports/exit-control?from=2026-10-13&to=2026-10-13&org_id=${otherOrgId}`)
      .set("Authorization", authorization(operator));
    expect(otherOrgResponse.status).toBe(404);
    await db("tb_operator_permissions")
      .where({ org_id: orgId, role: "operator", section_key: "reports" })
      .update({ can_view: false });
    const forbidden = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-13")
      .set("Authorization", authorization(operator));
    expect(forbidden.status).toBe(403);
  });

  it.each(["kassir", "registrator"] as const)("%s uchun 403 qaytaradi", async (role) => {
    const user = await createTestUser(orgId, { role });
    const actor: AuthTokenPayload = { id: user.id, org_id: orgId, role };
    const response = await request(app())
      .get("/api/reports/exit-control?from=2026-10-13&to=2026-10-13")
      .set("Authorization", authorization(actor));
    expect(response.status).toBe(403);
  });
});
