import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let operator: AuthTokenPayload;
let kassir: AuthTokenPayload;
let operatorLogin: string;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createCandidate(input: {
  targetOrgId?: number;
  plate?: string | null;
  confidence?: number | null;
  cameraEventAt: Date;
  resolvedAt?: Date;
  resolutionType?: "exit_cancelled" | "forced_open" | "exact";
  imageKind?: "overview" | "vehicle" | "plate" | null;
}): Promise<{ candidateId: number; eventId: number }> {
  const targetOrgId = input.targetOrgId ?? orgId;
  const imageKind = input.imageKind === undefined ? "overview" : input.imageKind;
  const eventValues: Record<string, unknown> = {
    org_id: targetOrgId,
    plate_number: input.plate ?? null,
    direction: "exit",
    camera_event_at: input.cameraEventAt,
  };
  if (imageKind) {
    eventValues[`${imageKind}_image_path`] =
      `uploads/parking-events/${targetOrgId}/2026/10/14/event/${imageKind}.jpg`;
  }
  const [eventId] = await db("tb_webhook_events").insert(eventValues);
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: targetOrgId,
    webhook_event_id: eventId,
    detected_plate: input.plate ?? null,
    confidence: input.confidence ?? null,
    camera_event_at: input.cameraEventAt,
    status: input.resolutionType === "exact" ? "accepted" : "dismissed",
    resolution_type: input.resolutionType ?? "exit_cancelled",
    resolved_by: operator.id,
    resolved_at: input.resolvedAt ?? input.cameraEventAt,
  });
  return { candidateId, eventId };
}

function cancelledUrl(query = ""): string {
  return `/api/exit-candidates/cancelled?from=2026-10-14&to=2026-10-14${query}`;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  const kassirUser = await createTestUser(orgId, { role: "kassir" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
  kassir = { id: kassirUser.id, org_id: orgId, role: "kassir" };
  operatorLogin = operatorUser.login;
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("GET /api/exit-candidates/cancelled", () => {
  it("faqat exit_cancelled nomzodlarni mavjud rasm endpointi bilan qaytaradi", async () => {
    const cameraEventAt = new Date("2026-10-14T08:30:00.000Z");
    const cancelled = await createCandidate({
      plate: "01A123BC",
      confidence: 92.5,
      cameraEventAt,
      imageKind: "vehicle",
    });
    await createCandidate({
      plate: "01F123BC",
      confidence: 80,
      cameraEventAt: new Date("2026-10-14T09:30:00.000Z"),
      resolutionType: "forced_open",
    });

    const response = await request(app)
      .get(cancelledUrl())
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body.history).toEqual([
      {
        id: cancelled.candidateId,
        detected_plate: "01A123BC",
        confidence: 92.5,
        camera_event_at: cameraEventAt.toISOString(),
        resolved_at: cameraEventAt.toISOString(),
        resolved_by: { id: operator.id, name: "Test User" },
        webhook_event_id: cancelled.eventId,
        has_image: true,
        image_url: `/api/webhook-events/${cancelled.eventId}/images/vehicle`,
      },
    ]);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, total_pages: 1 });
  });

  it("boshqa tashkilot yozuvini qaytarmaydi", async () => {
    await createCandidate({
      targetOrgId: otherOrgId,
      plate: "01X123BC",
      cameraEventAt: new Date("2026-10-14T08:30:00.000Z"),
    });

    const response = await request(app)
      .get(cancelledUrl())
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body.history).toEqual([]);
  });

  it("31 kundan uzun oraliq uchun 400 qaytaradi", async () => {
    const response = await request(app)
      .get("/api/exit-candidates/cancelled?from=2026-10-01&to=2026-11-01")
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(400);
  });

  it("tashkilot vaqt zonasidagi kun chegarasini ishlatadi", async () => {
    const included = await createCandidate({
      plate: "01TZ100A",
      cameraEventAt: new Date("2026-10-13T19:00:00.000Z"),
    });
    await createCandidate({
      plate: "01TZ100B",
      cameraEventAt: new Date("2026-10-13T18:59:59.000Z"),
    });
    await createCandidate({
      plate: "01TZ100C",
      cameraEventAt: new Date("2026-10-14T19:00:00.000Z"),
    });

    const response = await request(app)
      .get(cancelledUrl())
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body.history.map((row: { id: number }) => row.id)).toEqual([included.candidateId]);
  });

  it("nomersiz va rasmsiz nomzodni xatosiz qaytaradi", async () => {
    await db("tb_users").where({ id: operator.id }).update({ name: "" });
    const candidate = await createCandidate({
      plate: null,
      confidence: null,
      cameraEventAt: new Date("2026-10-14T10:30:00.000Z"),
      imageKind: null,
    });

    const response = await request(app)
      .get(cancelledUrl())
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body.history[0]).toMatchObject({
      id: candidate.candidateId,
      detected_plate: null,
      confidence: null,
      resolved_by: { id: operator.id, name: operatorLogin },
      webhook_event_id: candidate.eventId,
      has_image: false,
      image_url: null,
    });
  });

  it("camera_event_at kamayish tartibida sahifalaydi", async () => {
    const ids: number[] = [];
    for (let hour = 8; hour <= 10; hour += 1) {
      const paddedHour = String(hour).padStart(2, "0");
      ids.push((await createCandidate({
        plate: `01P100A${hour}`,
        cameraEventAt: new Date(`2026-10-14T${paddedHour}:00:00.000Z`),
      })).candidateId);
    }

    const response = await request(app)
      .get(cancelledUrl("&page=2&limit=2"))
      .set("Authorization", authorization(operator));

    expect(response.status).toBe(200);
    expect(response.body.history.map((row: { id: number }) => row.id)).toEqual([ids[0]]);
    expect(response.body.pagination).toEqual({ page: 2, limit: 2, total: 3, total_pages: 2 });
  });

  it("sessions ruxsati yo'q foydalanuvchini rad etadi", async () => {
    const response = await request(app)
      .get(cancelledUrl())
      .set("Authorization", authorization(kassir));

    expect(response.status).toBe(403);
  });
});
