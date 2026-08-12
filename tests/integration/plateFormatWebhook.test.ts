import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import {
  clearPlateFormatChecksForTests,
  pausePlateFormatCheckTimersForTests,
  PLATE_FORMAT_CHECK_WINDOW_MS,
  resumePlateFormatChecks,
} from "@/modules/plateFormats/plateFormatCheck.service";
import webhookRouter from "@/modules/webhook/webhook.routes";
import { getNextEntryCandidate } from "@/modules/entryCandidates/entryCandidates.service";
import { getNextExitCandidate } from "@/modules/exitCandidates/exitCandidates.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
} from "./helpers";

vi.mock("@/modules/relay/relay.service", () => ({
  openBarrier: vi.fn().mockResolvedValue({ status: "opened", success: true }),
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
  emitRelayFailed: vi.fn(),
  emitWebhookParseFailed: vi.fn(),
}));

let orgId: number;
let token: string;
let imageBase64: string;
let sequence = 0;

const app = express();
app.use("/api/webhook", webhookRouter);

function payload(plate: string, deviceId: string) {
  sequence += 1;
  return {
    Picture: {
      NormalPic: {
        Content: imageBase64,
        PicName: `${plate}-${Date.now()}-${sequence}.jpg`,
      },
    },
    Plate: { IsExist: true, PlateNumber: plate, Confidence: 91 },
    Vehicle: { VehicleBoundingBox: { Left: 10, Top: 10, Right: 180, Bottom: 130 } },
    SnapInfo: { DeviceID: deviceId, SnapTime: new Date().toISOString() },
  };
}

function postWebhook(direction: "entry" | "exit", plate: string, deviceId = `format-${direction}`) {
  return request(app)
    .post(`/api/webhook/camera/${token}/${direction}`)
    .set("Content-Type", "application/json")
    .send(payload(plate, deviceId));
}

async function waitForCandidate(direction: "entry" | "exit", timeoutMs = 5000) {
  const table = direction === "entry" ? "tb_entry_candidates" : "tb_exit_candidates";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await db(table).where({ org_id: orgId }).orderBy("id", "desc").first();
    if (candidate) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

beforeAll(async () => {
  await assertTestDatabase();
  imageBase64 = (
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#555" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  token = `plate-format-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db("tb_organizations").where({ id: orgId }).update({
    webhook_token: token,
    camera_brand: "dahua",
  });
  await createTestTariff(orgId);
  await db("tb_plate_formats").insert({ org_id: orgId, pattern: "NNLNNNLL" });
});

afterEach(async () => {
  await clearPlateFormatChecksForTests(orgId);
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
});

afterAll(closeDb);

describe("plate format validation webhook oqimi", () => {
  it("disabled holatda noto'g'ri formatni eski oqimda darhol ishlaydi", async () => {
    const response = await postWebhook("entry", "ABC12345");
    expect(response.body.plate_format_waiting).toBeUndefined();
    expect(
      await db("tb_parking_sessions").where({ org_id: orgId, plate_number: "ABC12345" }).first()
    ).toBeTruthy();
    expect(await db("tb_plate_format_checks").where({ org_id: orgId })).toHaveLength(0);
  });

  it.each(["entry", "exit"] as const)(
    "%s uchun birinchi valid webhook darhol odatdagi oqimga o'tadi",
    async (direction) => {
      await db("tb_organizations")
        .where({ id: orgId })
        .update({ plate_format_validation_enabled: true });
      const response = await postWebhook(direction, "01A123BC");
      expect(response.body.plate_format_waiting).toBeUndefined();
      expect(await db("tb_plate_format_checks").where({ org_id: orgId })).toHaveLength(0);
      if (direction === "entry") {
        expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeTruthy();
      } else {
        expect(await db("tb_exit_candidates").where({ org_id: orgId }).first()).toBeTruthy();
      }
    }
  );

  it.each(["entry", "exit"] as const)(
    "%s uchun invaliddan keyingi valid webhook kutmasdan odatdagi oqimga o'tadi",
    async (direction) => {
      await db("tb_organizations")
        .where({ id: orgId })
        .update({ plate_format_validation_enabled: true });
      const first = await postWebhook(direction, "01A12XBC");
      expect(first.body).toMatchObject({ plate_format_waiting: true, attempts: 1 });

      const second = await postWebhook(direction, "01A123BC");
      expect(second.body.plate_format_waiting).toBeUndefined();
      expect(await db("tb_plate_format_checks").where({ org_id: orgId })).toHaveLength(0);
      if (direction === "entry") {
        expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeTruthy();
      } else {
        const candidate = await db("tb_exit_candidates").where({ org_id: orgId }).first();
        expect(candidate).toMatchObject({ detected_plate: "01A123BC", suggested_plate: null });
      }
    }
  );

  it.each(["entry", "exit"] as const)(
    "%s uchun uchinchi invalid urinishda Aniqlanmadi va suggested_plate yaratadi",
    async (direction) => {
      await db("tb_organizations")
        .where({ id: orgId })
        .update({ plate_format_validation_enabled: true });
      expect((await postWebhook(direction, "01A12XBC")).body.attempts).toBe(1);
      expect((await postWebhook(direction, "01A12YBC")).body.attempts).toBe(2);
      const third = await postWebhook(direction, "01A12ZBC");
      expect(third.body).toMatchObject({
        candidate_created: true,
        plate_number: null,
        suggested_plate: "01A12ZBC",
      });
      const table = direction === "entry" ? "tb_entry_candidates" : "tb_exit_candidates";
      const candidate = await db(table).where({ org_id: orgId }).first();
      expect(candidate).toMatchObject({
        detected_plate: null,
        suggested_plate: "01A12ZBC",
        status: "pending",
      });
      const actor = { id: 0, org_id: orgId, role: "operator" as const };
      const next = direction === "entry"
        ? await getNextEntryCandidate(actor)
        : await getNextExitCandidate(actor, undefined);
      expect(next).toMatchObject({ suggested_plate: "01A12ZBC" });
    }
  );

  it("ikki invalid webhookdan keyin deadline oxirgi OCR qiymatini taklif qiladi", async () => {
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: true });
    await postWebhook("exit", "01A12XBC");
    const second = await postWebhook("exit", "01A12YBC");
    expect(second.body).toMatchObject({ plate_format_waiting: true, attempts: 2 });
    const candidate = await waitForCandidate("exit", PLATE_FORMAT_CHECK_WINDOW_MS + 2000);
    expect(candidate).toMatchObject({
      detected_plate: null,
      suggested_plate: "01A12YBC",
    });
  });

  it("server restartdan keyin DBdagi kutish holatini deadline bo'yicha tiklaydi", async () => {
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: true });
    await postWebhook("entry", "01A12XBC", "restart-camera");
    pausePlateFormatCheckTimersForTests();
    const check = await db("tb_plate_format_checks").where({ org_id: orgId }).first();
    expect(check).toMatchObject({ attempts: 1, status: "pending" });
    await db("tb_plate_format_checks")
      .where({ id: check.id })
      .update({ deadline_at: new Date(Date.now() + 100) });
    await resumePlateFormatChecks();
    const candidate = await waitForCandidate("entry", 2000);
    expect(candidate).toMatchObject({ suggested_plate: "01A12XBC" });
  });

  it.each(["entry", "exit"] as const)(
    "%s uchun bitta invalid webhook 3 soniyadan keyin Aniqlanmadi yaratadi",
    async (direction) => {
      await db("tb_organizations")
        .where({ id: orgId })
        .update({ plate_format_validation_enabled: true });
      const first = await postWebhook(direction, "01A12XBC");
      expect(first.body.plate_format_waiting).toBe(true);
      const candidate = await waitForCandidate(direction, PLATE_FORMAT_CHECK_WINDOW_MS + 2000);
      expect(candidate).toMatchObject({
        detected_plate: null,
        suggested_plate: "01A12XBC",
        status: "pending",
      });
    }
  );

  it("bir device ichidagi ikki fuzzy bo'lmagan raqamni mustaqil kuzatadi", async () => {
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: true });
    const deviceId = "shared-format-camera";
    await postWebhook("exit", "ABC12345", deviceId);
    await postWebhook("exit", "XYZ67890", deviceId);
    const initial = await db("tb_plate_format_checks")
      .where({ org_id: orgId, direction: "exit", device_id: deviceId })
      .orderBy("reference_plate");
    expect(initial.map((row) => [row.reference_plate, row.attempts])).toEqual([
      ["ABC12345", 1],
      ["XYZ67890", 1],
    ]);

    await postWebhook("exit", "ABC1234X", deviceId);
    const updated = await db("tb_plate_format_checks")
      .where({ org_id: orgId, direction: "exit", device_id: deviceId })
      .orderBy("reference_plate");
    expect(updated.map((row) => [row.reference_plate, row.attempts])).toEqual([
      ["ABC12345", 2],
      ["XYZ67890", 1],
    ]);
  });

  it("parallel uchta webhook urinishlarni yo'qotmaydi va bitta candidate yaratadi", async () => {
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: true });
    const responses = await Promise.all([
      postWebhook("exit", "01A12XBC", "race-camera"),
      postWebhook("exit", "01A12YBC", "race-camera"),
      postWebhook("exit", "01A12ZBC", "race-camera"),
    ]);
    expect(responses.some((response) => response.body.candidate_created === true)).toBe(true);
    const candidates = await db("tb_exit_candidates").where({ org_id: orgId });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].detected_plate).toBeNull();
    expect(candidates[0].suggested_plate).toMatch(/^01A12[XYZ]BC$/);
    expect(await db("tb_plate_format_checks").where({ org_id: orgId })).toHaveLength(0);
  });

  it("aktiv format bo'lmasa validation yoqilgan bo'lsa ham bloklamaydi", async () => {
    await db("tb_plate_formats").where({ org_id: orgId }).update({ is_active: false });
    await db("tb_organizations")
      .where({ id: orgId })
      .update({ plate_format_validation_enabled: true });
    const response = await postWebhook("entry", "ABC12345");
    expect(response.body.plate_format_waiting).toBeUndefined();
    expect(await db("tb_parking_sessions").where({ org_id: orgId }).first()).toBeTruthy();
  });
});
