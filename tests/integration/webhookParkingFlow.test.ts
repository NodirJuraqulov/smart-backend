import http from "http";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { clearWebhookDedupeCache } from "@/modules/webhook/webhookIdempotency";
import {
  emitEntryDetected,
  emitExitAwaitingPayment,
  emitExitCompleted,
  emitExitCandidateCreated,
  emitParkingFull,
  emitPlateNotRecognizedForExit,
  emitRelayFailed,
  emitWebhookParseFailed,
} from "@/websocket/socketServer";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestActiveSession,
  createTestSubscription,
  createTestTariff,
  createTestVipVehicle,
  setOrgCapacity,
} from "./helpers";

vi.mock("@/websocket/socketServer", () => ({
  emitEntryDetected: vi.fn(),
  emitParkingFull: vi.fn(),
  emitExitAwaitingPayment: vi.fn(),
  emitExitCompleted: vi.fn(),
  emitExitCandidateCreated: vi.fn(),
  emitExitCandidateResolved: vi.fn(),
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
}));

let orgId: number;
let webhookToken: string;
let server: http.Server;

function buildHikvisionBody(plateNumber: string, confidence = 92): { contentType: string; rawBody: Buffer } {
  const boundary = `Boundary${Math.random().toString(36).slice(2)}`;
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<EventNotificationAlert>" +
    "<dateTime>2026-07-25T10:00:00+05:00</dateTime>" +
    `<ANPR><licensePlate>${plateNumber}</licensePlate><confidenceLevel>${confidence}</confidenceLevel></ANPR>` +
    "</EventNotificationAlert>";
  const rawBody = Buffer.from(
    `--${boundary}\r\nContent-Type: application/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`
  );
  return { contentType: `multipart/form-data; boundary=${boundary}`, rawBody };
}

async function postWebhook(
  direction: "entry" | "exit",
  plateNumber: string,
  confidence = 92,
  token = webhookToken
) {
  const { contentType, rawBody } = buildHikvisionBody(plateNumber, confidence);
  return request(server)
    .post(`/api/webhook/hikvision/${token}/${direction}`)
    .set("Content-Type", contentType)
    .send(rawBody);
}

async function activeSessionCount(): Promise<number> {
  const [{ count }] = await db("tb_parking_sessions")
    .where({ org_id: orgId, status: "active" })
    .count<{ count: string }[]>("id as count");
  return Number(count);
}

beforeAll(async () => {
  await assertTestDatabase();
  const app = express();
  app.use("/api/webhook", webhookRouter);
  server = http.createServer(app);
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  webhookToken = `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({ webhook_token: webhookToken });
  await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 0 });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
  await clearWebhookDedupeCache();
});

afterAll(async () => {
  server?.close();
  await closeDb();
});

describe("Kirish webhook", () => {
  it("faol sessiya yaratadi va entry_detected eventini yuboradi", async () => {
    const res = await postWebhook("entry", "01A111AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(1);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A111AA" }).first();
    expect(session.status).toBe("active");
    expect(session.session_source).toBe("regular");

    expect(emitEntryDetected).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01A111AA" })
    );
    expect(openBarrier).toHaveBeenCalledWith(orgId, "entry");
  });

  it("rele xato qaytarsa — sessiya baribir yaratiladi, relay_failed eventi yuboriladi", async () => {
    vi.mocked(openBarrier).mockResolvedValueOnce({ status: "failed", success: false });

    const res = await postWebhook("entry", "01A112AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(1);
    expect(emitRelayFailed).toHaveBeenCalledWith(orgId, expect.objectContaining({ direction: "entry" }));
  });

  it("sig'im to'liq bo'lsa — sessiya yaratilmaydi, parking_full eventi yuboriladi", async () => {
    await setOrgCapacity(orgId, 1);
    await postWebhook("entry", "01A222AA");
    expect(await activeSessionCount()).toBe(1);

    const res = await postWebhook("entry", "01A333AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(1);
    expect(emitParkingFull).toHaveBeenCalledWith(orgId, expect.objectContaining({ plateNumber: "01A333AA" }));
  });

  it("mashina allaqachon ichkarida bo'lsa — yangi sessiya yaratilmaydi", async () => {
    await postWebhook("entry", "01A444AA");
    expect(await activeSessionCount()).toBe(1);
    await clearWebhookDedupeCache();

    const res = await postWebhook("entry", "01A444AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(1);
  });
});

describe("Chiqish webhook", () => {
  it("faol sessiya topilsa — pending candidate yaratadi va sessiyaga tegmaydi", async () => {
    await postWebhook("entry", "01A555AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A555AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A555AA" }).first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
    expect(session.amount).toBeNull();
    const candidate = await db("tb_exit_candidates").where({ org_id: orgId }).first();
    expect(candidate).toMatchObject({ status: "pending", matched_session_id: session.id });
    expect(emitExitCandidateCreated).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ id: candidate.id, matched_session_id: session.id })
    );
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    expect(emitExitCompleted).not.toHaveBeenCalled();
  });

  it("faol sessiya topilmasa — unmatched pending candidate yaratadi", async () => {
    const res = await postWebhook("exit", "01A666AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(0);
    expect(await db("tb_exit_candidates").where({ org_id: orgId }).first()).toMatchObject({
      status: "pending",
      detected_plate: "01A666AA",
      matched_session_id: null,
    });
    expect(emitPlateNotRecognizedForExit).not.toHaveBeenCalled();
  });

  it("VIP mashina uchun — pending candidate yaratadi", async () => {
    await createTestVipVehicle(orgId, "01A777AA");
    await postWebhook("entry", "01A777AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A777AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A777AA" }).first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
    expect(await db("tb_exit_candidates").where({ matched_session_id: session.id }).first()).toBeTruthy();
    expect(emitExitCompleted).not.toHaveBeenCalled();
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    expect(openBarrier).not.toHaveBeenCalledWith(orgId, "exit");
  });

  it("obuna mashina uchun — pending candidate yaratadi", async () => {
    await createTestSubscription(orgId, "01A888AA");
    await postWebhook("entry", "01A888AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A888AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A888AA" }).first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
    expect(await db("tb_exit_candidates").where({ matched_session_id: session.id }).first()).toBeTruthy();
  });
});

describe("Shared gate cross-camera guard", () => {
  beforeEach(async () => {
    await db("tb_organizations").where({ id: orgId }).update({
      gate_layout: "shared",
      cross_camera_guard_seconds: 90,
    });
  });

  it("entry dan keyingi exit echo sessiyani yopmaydi va side-effect yaratmaydi", async () => {
    await postWebhook("entry", "01A123BC");
    vi.clearAllMocks();

    const echo = await postWebhook("exit", "01A123BC");
    expect(echo.body).toEqual({
      ok: true,
      parsed: true,
      ignored: true,
      reason: "opposite_camera_echo",
    });

    const session = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A123BC" })
      .first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
    expect(session.amount).toBeNull();
    expect(openBarrier).not.toHaveBeenCalled();
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    const [{ count }] = await db("tb_payments")
      .where({ org_id: orgId })
      .count<{ count: string }[]>("id as count");
    expect(Number(count)).toBe(0);
  });

  it("guard tugagach haqiqiy exit normal ishlaydi", async () => {
    await postWebhook("entry", "01A124BC");
    await db("tb_webhook_events")
      .where({ org_id: orgId, plate_number: "01A124BC", direction: "entry" })
      .update({
        camera_event_at: null,
        created_at: new Date(Date.now() - 92_000),
        processed_at: new Date(Date.now() - 92_000),
      });

    const exit = await postWebhook("exit", "01A124BC");
    expect(exit.body.ignored).toBeUndefined();
    const session = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A124BC" })
      .first();
    expect(session.status).toBe("active");
    expect(session.exited_at).toBeNull();
    expect(await db("tb_exit_candidates").where({ matched_session_id: session.id }).first()).toBeTruthy();
  });

  it("exit dan keyingi entry echo ham simmetrik ignored bo'ladi", async () => {
    await createTestActiveSession(orgId, "01A125BC", new Date(Date.now() - 120_000));
    await postWebhook("exit", "01A125BC");
    vi.clearAllMocks();

    const echo = await postWebhook("entry", "01A125BC");
    expect(echo.body).toMatchObject({
      parsed: true,
      ignored: true,
      reason: "opposite_camera_echo",
    });
    expect(openBarrier).not.toHaveBeenCalled();
    const [{ count }] = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A125BC" })
      .count<{ count: string }[]>("id as count");
    expect(Number(count)).toBe(1);
  });

  it("separate layout qarama-qarshi yo'nalishni to'xtatmaydi", async () => {
    await db("tb_organizations").where({ id: orgId }).update({ gate_layout: "separate" });
    await postWebhook("entry", "01A126BC");
    const exit = await postWebhook("exit", "01A126BC");
    expect(exit.body.ignored).toBeUndefined();
    const session = await db("tb_parking_sessions")
      .where({ org_id: orgId, plate_number: "01A126BC" })
      .first();
    expect(session.status).toBe("active");
    expect(await db("tb_exit_candidates").where({ matched_session_id: session.id }).first()).toBeTruthy();
  });

  it("boshqa org va boshqa plate hodisalari guard bilan aralashmaydi", async () => {
    await postWebhook("entry", "01A127BC");

    const otherOrgId = await createTestOrganization();
    const otherToken = `other-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db("tb_organizations").where({ id: otherOrgId }).update({
      webhook_token: otherToken,
      gate_layout: "shared",
      cross_camera_guard_seconds: 90,
    });
    await createTestTariff(otherOrgId, { price_per_hour: 5000 });
    try {
      const otherOrgEvent = await postWebhook("exit", "01A127BC", 92, otherToken);
      expect(otherOrgEvent.body.reason).toBeUndefined();

      const differentPlate = await postWebhook("exit", "01A999BC");
      expect(differentPlate.body.reason).toBeUndefined();
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });
});

describe("Idempotentlik", () => {
  it("10 soniya ichida takroriy kirish webhooki ikkinchi marta sessiya yaratmaydi", async () => {
    await postWebhook("entry", "01A999AA");
    expect(await activeSessionCount()).toBe(1);

    const res = await postWebhook("entry", "01A999AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(1);
    expect(emitEntryDetected).toHaveBeenCalledTimes(1);
  });

  it("10 soniya ichida takroriy chiqish webhooki ikkinchi marta yangilanmaydi", async () => {
    await postWebhook("entry", "01B111AA");
    await clearWebhookDedupeCache();
    await postWebhook("exit", "01B111AA");

    const beforeSecond = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01B111AA" }).first();

    const res = await postWebhook("exit", "01B111AA");

    expect(res.status).toBe(200);
    const afterSecond = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01B111AA" }).first();
    expect(afterSecond.exited_at).toEqual(beforeSecond.exited_at);
    expect(emitPlateNotRecognizedForExit).not.toHaveBeenCalled();
  });
});

describe("Webhook parse xatosi", () => {
  it("notanish format kelganda — webhook_parse_failed eventi org va public xonalariga yuboriladi", async () => {
    const res = await request(server)
      .post(`/api/webhook/hikvision/${webhookToken}/entry`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("bu hikvision formatida emas"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, parsed: false });
    expect(emitWebhookParseFailed).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ direction: "entry" })
    );
  });

  it("to'g'ri format kelganda — webhook_parse_failed eventi yuborilmaydi", async () => {
    const res = await postWebhook("entry", "01B222AA");

    expect(res.status).toBe(200);
    expect(emitWebhookParseFailed).not.toHaveBeenCalled();
  });
});
