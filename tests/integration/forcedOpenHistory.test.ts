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

async function createCandidate(input: {
  orgId?: number;
  plateNumber: string;
  resolutionType: "forced_open" | "exact" | "reassigned";
  resolvedAt: Date;
  resolvedBy: number;
  note?: string | null;
  imageKind?: "overview" | "vehicle" | "plate";
}): Promise<number> {
  const targetOrgId = input.orgId ?? orgId;
  const [eventId] = await db("tb_webhook_events").insert({
    org_id: targetOrgId,
    plate_number: input.plateNumber,
    direction: "exit",
    camera_event_at: input.resolvedAt,
    [`${input.imageKind ?? "overview"}_image_path`]: `uploads/parking-events/${targetOrgId}/test.jpg`,
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: targetOrgId,
    webhook_event_id: eventId,
    detected_plate: input.plateNumber,
    confidence: 95,
    camera_event_at: input.resolvedAt,
    status: input.resolutionType === "forced_open" ? "dismissed" : "accepted",
    resolution_type: input.resolutionType,
    resolved_by: input.resolvedBy,
    resolved_at: input.resolvedAt,
    resolution_note: input.note ?? null,
  });
  return candidateId;
}

beforeAll(async () => {
  await assertTestDatabase();
});

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

afterAll(async () => {
  await closeDb();
});

describe("GET /api/organizations/:id/forced-open-history", () => {
  it("forced_open yozuvlarini operator nomi va rasm URL bilan qaytaradi", async () => {
    const resolvedAt = new Date("2026-08-21T08:30:00.000Z");
    const candidateId = await createCandidate({
      plateNumber: "01A123BC",
      resolutionType: "forced_open",
      resolvedAt,
      resolvedBy: operator.id,
      note: "Kirish sessiyasi topilmadi",
    });

    for (const actor of [owner, kassir, superAdmin]) {
      const response = await request(app)
        .get(`/api/organizations/${orgId}/forced-open-history`)
        .set("Authorization", authorization(actor));

      expect(response.status).toBe(200);
      expect(response.body.history).toEqual([
        {
          id: candidateId,
          plate_number: "01A123BC",
          resolved_at: resolvedAt.toISOString(),
          resolved_by: { id: operator.id, name: "Test User" },
          resolution_note: "Kirish sessiyasi topilmadi",
          image_url: expect.stringMatching(
            new RegExp(`^/api/webhook-events/\\d+/images/overview$`)
          ),
        },
      ]);
      expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, total_pages: 1 });
    }
  });

  it("exact va reassigned candidate yozuvlarini ro'yxatga kiritmaydi", async () => {
    const now = new Date();
    await createCandidate({
      plateNumber: "01E100AA",
      resolutionType: "exact",
      resolvedAt: now,
      resolvedBy: operator.id,
    });
    await createCandidate({
      plateNumber: "01R100AA",
      resolutionType: "reassigned",
      resolvedAt: now,
      resolvedBy: operator.id,
    });

    const response = await request(app)
      .get(`/api/organizations/${orgId}/forced-open-history`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body.history).toEqual([]);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 0, total_pages: 1 });
  });

  it("page va limit bo'yicha sahifalaydi", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(
        await createCandidate({
          plateNumber: `01P100A${index}`,
          resolutionType: "forced_open",
          resolvedAt: new Date(`2026-08-21T08:0${index}:00.000Z`),
          resolvedBy: operator.id,
        })
      );
    }

    const response = await request(app)
      .get(`/api/organizations/${orgId}/forced-open-history?page=2&limit=2`)
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body.history.map((item: { id: number }) => item.id)).toEqual([ids[0]]);
    expect(response.body.pagination).toEqual({ page: 2, limit: 2, total: 3, total_pages: 2 });
  });

  it("operator roliga 403 qaytaradi", async () => {
    const response = await request(app)
      .get(`/api/organizations/${orgId}/forced-open-history`)
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(403);
  });

  it("boshqa tashkilot tarixiga 404 qaytaradi", async () => {
    await createCandidate({
      plateNumber: "01X100AA",
      resolutionType: "forced_open",
      resolvedAt: new Date(),
      resolvedBy: operator.id,
    });

    const response = await request(app)
      .get(`/api/organizations/${orgId}/forced-open-history`)
      .set("Authorization", authorization(otherOwner));

    expect(response.status).toBe(404);
  });
});
