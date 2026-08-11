import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/config/db";
import { env } from "@/config/env";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import entryCandidatesRouter from "@/modules/entryCandidates/entryCandidates.routes";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
  setOrgCapacity,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true, detail: "opened" }),
}));

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitEntryBarrierFailed: vi.fn(),
  emitEntryCandidateCreated: vi.fn(),
  emitEntryCandidateResolved: vi.fn(),
  emitEntryCompleted: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitPublicEntryStatusChanged: vi.fn(),
  emitPublicExitStatusChanged: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

let orgId: number;
let webhookToken: string;
let owner: AuthTokenPayload;
let superAdmin: AuthTokenPayload;
let jpegBase64: string;

const app = express();
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/entry-candidates", entryCandidatesRouter);
app.use("/api/parking", parkingRouter);
app.use("/api/admin/organizations", organizationsRouter);
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;

function auth(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function dahuaBody(plate: string) {
  return {
    Picture: {
      NormalPic: { Content: jpegBase64, PicName: `${plate}.jpg` },
      PlatePic: { Content: jpegBase64, PicName: "plate.jpg" },
    },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 92 },
    Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: "url-camera", SnapTime: new Date().toISOString() },
  };
}

async function postWebhook(direction: "entry" | "exit", plate: string) {
  return testRequest(app)
    .post(`/api/webhook/camera/${webhookToken}/${direction}`)
    .set("Content-Type", "application/json")
    .send(dahuaBody(plate));
}

function expectRelative(value: unknown, prefix: string) {
  expect(typeof value).toBe("string");
  const url = value as string;
  expect(url.startsWith(prefix)).toBe(true);
  expect(url.startsWith("http://")).toBe(false);
  expect(url.startsWith("https://")).toBe(false);
  expect(url).not.toContain(env.publicBaseUrl);
}

beforeAll(async () => {
  await assertTestDatabase();
  jpegBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  webhookToken = `imgurl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await testDb("tb_organizations").where({ id: orgId }).update({
    webhook_token: webhookToken,
    camera_brand: "dahua",
    gate_layout: "separate",
  });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };

  const adminUser = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
});

afterEach(async () => {
  await clearWebhookDedupeCache(orgId);
  for (const folder of ["parking-events", "parking"]) {
    await fs.rm(path.join(process.cwd(), "uploads", folder, String(orgId)), {
      recursive: true,
      force: true,
    });
  }
  await cleanupOrganization(orgId);
  await testDb("tb_users").whereNull("org_id").del();
});

afterAll(closeDb);

describe("rasm URL'lari nisbiy qaytadi", () => {
  it("1. exit candidate rasm URL'lari nisbiy", async () => {
    await createTestActiveSession(orgId, "01U100AA", new Date(Date.now() - 60 * 60_000));
    await postWebhook("exit", "01U100AA");

    const next = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", auth(owner));
    expect(next.status).toBe(200);
    expectRelative(next.body.exit_images.overview_url, "/api/webhook-events/");

    const candidate = await testDb("tb_exit_candidates").where({ org_id: orgId }).first();
    const detail = await testRequest(app)
      .get(`/api/exit-candidates/${candidate.id}`)
      .set("Authorization", auth(owner));
    expect(detail.status).toBe(200);
    expectRelative(detail.body.candidate.overviewImageUrl, "/api/webhook-events/");
    expectRelative(detail.body.candidate.plateImageUrl, "/api/webhook-events/");
  });

  it("2. entry candidate rasm URL'lari nisbiy", async () => {
    await setOrgCapacity(orgId, 0);
    await postWebhook("entry", "01U200AA");

    const next = await testRequest(app)
      .get("/api/entry-candidates/next")
      .set("Authorization", auth(owner));
    expect(next.status).toBe(200);
    expectRelative(next.body.entry_images.overview_url, "/api/webhook-events/");
  });

  it("3. session rasm URL'lari nisbiy", async () => {
    await setOrgCapacity(orgId, 5);
    await postWebhook("entry", "01U300AA");

    const session = await testDb("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01U300AA" })
      .first();
    expect(session.entry_overview_image_path).not.toBeNull();

    const detail = await testRequest(app)
      .get(`/api/parking/sessions/${session.id}`)
      .set("Authorization", auth(owner));
    expect(detail.status).toBe(200);
    expectRelative(detail.body.session.entryOverviewImageUrl, "/api/parking/sessions/");

    const list = await testRequest(app)
      .get("/api/parking/active")
      .set("Authorization", auth(owner));
    expect(list.status).toBe(200);
    expectRelative(list.body.sessions[0].entryOverviewImageUrl, "/api/parking/sessions/");
  });

  it("4. kamera webhook manzillari hali to'liq PUBLIC_BASE_URL bilan qaytadi", async () => {
    const response = await testRequest(app)
      .get(`/api/admin/organizations/${orgId}/integration-settings`)
      .set("Authorization", auth(superAdmin));
    expect(response.status).toBe(200);

    const settings = response.body.settings ?? response.body;
    const urls = JSON.stringify(settings);
    expect(urls).toContain(env.publicBaseUrl);
    expect(urls).toContain(`${env.publicBaseUrl}/api/webhook/`);
  });

  it("5. nisbiy URL'lar haqiqiy rasmni qaytaradi", async () => {
    await setOrgCapacity(orgId, 5);
    await postWebhook("entry", "01U400AA");

    const session = await testDb("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01U400AA" })
      .first();
    const detail = await testRequest(app)
      .get(`/api/parking/sessions/${session.id}`)
      .set("Authorization", auth(owner));

    const imageUrl = detail.body.session.entryOverviewImageUrl as string;
    const image = await testRequest(app).get(imageUrl).set("Authorization", auth(owner));
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image");
  });
});
