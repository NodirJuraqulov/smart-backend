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
  emitPlateNotRecognizedForExit: vi.fn(),
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue(true),
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

async function postWebhook(direction: "entry" | "exit", plateNumber: string, confidence = 92) {
  const { contentType, rawBody } = buildHikvisionBody(plateNumber, confidence);
  return request(server)
    .post(`/api/webhook/hikvision/${webhookToken}/${direction}`)
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
    vi.mocked(openBarrier).mockResolvedValueOnce(false);

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
  it("faol sessiya topilsa — status awaiting_payment ga o'tadi, summa hisoblanadi", async () => {
    await postWebhook("entry", "01A555AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A555AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A555AA" }).first();
    expect(session.status).toBe("awaiting_payment");
    expect(session.exited_at).toBeTruthy();
    expect(Number(session.amount)).toBeGreaterThanOrEqual(0);

    expect(emitExitAwaitingPayment).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        plateNumber: "01A555AA",
        enteredAt: session.entered_at,
        durationMinutes: session.duration_minutes,
      })
    );
    expect(emitExitCompleted).not.toHaveBeenCalled();
  });

  it("faol sessiya topilmasa — hech narsa o'zgarmaydi, plate_not_recognized_for_exit eventi yuboriladi", async () => {
    const res = await postWebhook("exit", "01A666AA");

    expect(res.status).toBe(200);
    expect(await activeSessionCount()).toBe(0);
    expect(emitPlateNotRecognizedForExit).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ plateNumber: "01A666AA" })
    );
  });

  it("VIP mashina uchun — darhol completed, to'lov kutilmaydi", async () => {
    await createTestVipVehicle(orgId, "01A777AA");
    await postWebhook("entry", "01A777AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A777AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A777AA" }).first();
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);

    expect(emitExitCompleted).toHaveBeenCalledWith(orgId, expect.objectContaining({ plateNumber: "01A777AA", amount: 0 }));
    expect(emitExitAwaitingPayment).not.toHaveBeenCalled();
    expect(openBarrier).toHaveBeenCalledWith(orgId, "exit");
  });

  it("obuna mashina uchun — darhol completed, to'lov kutilmaydi", async () => {
    await createTestSubscription(orgId, "01A888AA");
    await postWebhook("entry", "01A888AA");
    await clearWebhookDedupeCache();

    const res = await postWebhook("exit", "01A888AA");

    expect(res.status).toBe(200);

    const session = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "01A888AA" }).first();
    expect(session.status).toBe("completed");
    expect(Number(session.amount)).toBe(0);
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
