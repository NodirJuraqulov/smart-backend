import { promises as fs } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import authRouter from "@/modules/auth/auth.routes";
import blacklistRouter from "@/modules/blacklist/blacklist.routes";
import cashCollectionsRouter from "@/modules/cashCollections/cashCollections.routes";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import parkingRouter from "@/modules/parking/parking.routes";
import reportsRouter from "@/modules/reports/reports.routes";
import settingsRouter from "@/modules/settings/settings.routes";
import tariffsRouter from "@/modules/tariffs/tariffs.routes";
import usersRouter from "@/modules/users/users.routes";
import vipVehiclesRouter from "@/modules/vipVehicles/vipVehicles.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/admin/users", usersRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/vip-vehicles", vipVehiclesRouter);
app.use("/api/tariffs", tariffsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/organizations", cashCollectionsRouter);
app.use("/api/organizations", blacklistRouter);
app.use("/api/parking", parkingRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let activeSessionId: number;
let completedSessionId: number;
let foreignSessionId: number;
let registrator: AuthTokenPayload;
let owner: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });

  activeSessionId = await createTestActiveSession(orgId, "01R100AA");
  completedSessionId = await createTestActiveSession(orgId, "01R200AA");
  foreignSessionId = await createTestActiveSession(otherOrgId, "01R300AA");
  await db("tb_parking_sessions").where({ id: completedSessionId }).update({
    status: "completed",
    exited_at: new Date(),
    duration_minutes: 10,
    amount: 5000,
    exit_method: "manual",
    active_plate_key: null,
  });

  const imagePath = path.posix.join(
    "uploads",
    "parking",
    String(orgId),
    String(activeSessionId),
    "entry_overview.jpg"
  );
  const absoluteImagePath = path.resolve(process.cwd(), imagePath);
  await fs.mkdir(path.dirname(absoluteImagePath), { recursive: true });
  await fs.writeFile(absoluteImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await db("tb_parking_sessions").where({ id: activeSessionId }).update({
    entry_overview_image_path: imagePath,
  });

  const registratorUser = await createTestUser(orgId, { role: "registrator" });
  registrator = { id: registratorUser.id, org_id: orgId, role: "registrator" };
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await fs.rm(path.join(process.cwd(), "uploads", "parking", String(orgId)), {
    recursive: true,
    force: true,
  });
});

afterAll(closeDb);

describe("registrator role access", () => {
  it("registrator active sessiyalarni qidiradi, ko'radi va kirish rasmini oladi", async () => {
    const list = await request(app)
      .get("/api/parking/sessions?status=active&plate_number=01R100AA")
      .set("Authorization", authorization(registrator));

    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({
      id: activeSessionId,
      org_id: orgId,
      plate_number: "01R100AA",
      status: "active",
      entryOverviewImageUrl: `/api/parking/sessions/${activeSessionId}/images/entry-overview`,
    });

    const detail = await request(app)
      .get(`/api/parking/sessions/${activeSessionId}`)
      .set("Authorization", authorization(registrator));
    expect(detail.status).toBe(200);
    expect(detail.body.session).toMatchObject({ id: activeSessionId, status: "active" });

    const image = await request(app)
      .get(`/api/parking/sessions/${activeSessionId}/images/entry-overview`)
      .set("Authorization", authorization(registrator));
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/jpeg");

    const foreignList = await request(app)
      .get(`/api/parking/sessions?status=active&org_id=${otherOrgId}`)
      .set("Authorization", authorization(registrator));
    const foreignDetail = await request(app)
      .get(`/api/parking/sessions/${foreignSessionId}`)
      .set("Authorization", authorization(registrator));
    expect(foreignList.status).toBe(404);
    expect(foreignDetail.status).toBe(404);
  });

  it("registrator completed yoki statussiz sessions so'roviga 403 oladi", async () => {
    const completed = await request(app)
      .get("/api/parking/sessions?status=completed")
      .set("Authorization", authorization(registrator));
    const withoutStatus = await request(app)
      .get("/api/parking/sessions")
      .set("Authorization", authorization(registrator));
    const completedDetail = await request(app)
      .get(`/api/parking/sessions/${completedSessionId}`)
      .set("Authorization", authorization(registrator));

    expect(completed.status).toBe(403);
    expect(withoutStatus.status).toBe(403);
    expect(completedDetail.status).toBe(403);
  });

  it("registrator boshqa barcha himoyalangan endpointlarda 403 oladi", async () => {
    const calls = [
      request(app).get("/api/auth/me"),
      request(app).get("/api/reports/daily"),
      request(app).get("/api/vip-vehicles"),
      request(app).get("/api/tariffs"),
      request(app).get("/api/settings"),
      request(app).get(`/api/organizations/${orgId}/cash-collections`),
      request(app).get(`/api/organizations/${orgId}/blacklist`),
      request(app).get("/api/exit-candidates/next"),
      request(app).post("/api/exit-candidates/1/force-open"),
      request(app).post("/api/exit-candidates/1/confirm"),
      request(app).post("/api/parking/entry/manual"),
      request(app).post("/api/parking/exit/manual"),
      request(app).post(`/api/parking/sessions/${activeSessionId}/force-close`),
      request(app).get("/api/parking/active"),
      request(app).get("/api/parking/capacity"),
      request(app).get("/api/admin/users"),
    ];

    const responses = await Promise.all(
      calls.map((call) => call.set("Authorization", authorization(registrator)).send({}))
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: calls.length }, () => 403)
    );
  });

  it("owner o'z tashkilotiga registrator yarata oladi", async () => {
    const login = `registrator_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const response = await request(app)
      .post("/api/admin/users")
      .set("Authorization", authorization(owner))
      .send({
        org_id: orgId,
        name: "Test Registrator",
        login,
        password: "registrator-password-123",
        role: "registrator",
      });

    expect(response.status).toBe(201);
    expect(response.body.operator).toMatchObject({
      org_id: orgId,
      name: "Test Registrator",
      login,
      role: "registrator",
    });
    expect(Boolean(response.body.operator.is_active)).toBe(true);
    expect(await db("tb_users").where({ login }).first()).toMatchObject({
      org_id: orgId,
      role: "registrator",
    });
  });

  it("owner boshqa tashkilotga registrator yarata olmaydi", async () => {
    const response = await request(app)
      .post("/api/admin/users")
      .set("Authorization", authorization(owner))
      .send({
        org_id: otherOrgId,
        name: "Begona Registrator",
        login: `foreign_registrator_${Date.now()}`,
        password: "registrator-password-123",
        role: "registrator",
      });

    expect(response.status).toBe(404);
  });
});
