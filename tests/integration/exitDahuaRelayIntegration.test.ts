import http from "http";
import { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import { encryptSecret } from "@/utils/encryption";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

let orgId: number;
let actor: AuthTokenPayload;
let app: express.Express;

async function createCandidate(plate: string) {
  const [sessionId] = await db("tb_parking_sessions").insert({
    org_id: orgId,
    plate_number: plate,
    entered_at: new Date(Date.now() - 60 * 60 * 1000),
    status: "active",
    entry_method: "auto",
    session_source: "regular",
    tariff_price_per_hour: 5000,
    tariff_grace_period_minutes: 0,
    active_plate_key: `${orgId}:${plate}`,
  });
  const [eventId] = await db("tb_webhook_events").insert({
    org_id: orgId,
    plate_number: plate,
    direction: "exit",
    camera_event_at: new Date(),
  });
  const [candidateId] = await db("tb_exit_candidates").insert({
    org_id: orgId,
    webhook_event_id: eventId,
    detected_plate: plate,
    matched_session_id: sessionId,
    camera_event_at: new Date(),
  });
  return { sessionId, candidateId };
}

function authHeader() {
  return `Bearer ${signAccessToken(actor)}`;
}

beforeAll(async () => {
  await assertTestDatabase();
  app = express();
  app.use(express.json());
  app.use("/api/exit-candidates", exitCandidatesRouter);
  app.use(errorHandler);
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await createTestTariff(orgId);
  const user = await createTestUser(orgId, { role: "owner" });
  actor = { id: user.id, org_id: orgId, role: "owner" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("exit candidate Dahua relay integration", () => {
  it("host konfiguratsiya qilinmagan confirm not_configured qaytaradi", async () => {
    const candidate = await createCandidate("01X100AA");
    const response = await request(app)
      .post(`/api/exit-candidates/${candidate.candidateId}/confirm`)
      .set("Authorization", authHeader())
      .send({ payment_method: "cash" });
    expect(response.status).toBe(200);
    expect(response.body.barrier_status).toBe("not_configured");
    expect((await db("tb_parking_sessions").where({ id: candidate.sessionId }).first()).status).toBe("completed");
  });

  it("host konfiguratsiya qilingan confirm Digest relayni haqiqiy HTTP stub orqali chaqiradi", async () => {
    let authenticatedRequest = false;
    const relayServer = http.createServer((req, res) => {
      if (!req.headers.authorization) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Digest realm="Dahua", nonce="exit123", qop="auth", algorithm=MD5');
        res.end();
        return;
      }
      authenticatedRequest = /^Digest /.test(req.headers.authorization);
      res.statusCode = 200;
      res.end("OK");
    });
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    const port = (relayServer.address() as AddressInfo).port;
    await db("tb_organizations").where({ id: orgId }).update({
      exit_camera_relay_host: "127.0.0.1",
      exit_camera_relay_port: port,
      exit_camera_relay_username: "admin",
      exit_camera_relay_password_encrypted: encryptSecret("secret"),
      exit_camera_relay_channel: 1,
    });
    const candidate = await createCandidate("01X101AA");
    try {
      const response = await request(app)
        .post(`/api/exit-candidates/${candidate.candidateId}/confirm`)
        .set("Authorization", authHeader())
        .send({ payment_method: "cash" });
      expect(response.status).toBe(200);
      expect(response.body.barrier_status).toBe("opened");
      expect(authenticatedRequest).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => relayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
