import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { entryAuto, exitManual, exitAuto, entryManual } from "@/modules/parking/parking.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { detectPlate } from "@/services/ocr.service";
import { saveParkingImage } from "@/utils/imageStorage";
import { emitDetectionFailed, emitParkingEntry, emitParkingExit } from "@/websocket/socketServer";
import {
  assertTestDatabase,
  cleanupOrganization,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
  closeDb,
} from "./helpers";

vi.mock("@/services/ocr.service", () => ({ detectPlate: vi.fn() }));
vi.mock("@/utils/imageStorage", () => ({ saveParkingImage: vi.fn() }));
vi.mock("@/websocket/socketServer", () => ({
  emitParkingEntry: vi.fn(),
  emitParkingExit: vi.fn(),
  emitDetectionFailed: vi.fn(),
}));

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await createTestTariff(orgId);
  await createTestSettings(orgId, { work_hours_enabled: false });
  const user = await createTestUser(orgId);
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeDb();
});

async function activeSessionCount(): Promise<number> {
  const [{ count }] = await db("tb_parking_sessions").where({ org_id: orgId }).count<{ count: string }[]>(
    "id as count"
  );
  return Number(count);
}

describe("entryAuto — candidate_found: false (YOLOv8 hech narsa topmagan)", () => {
  it("rasm saqlanmaydi, websocket eventi yuborilmaydi, sessiya yaratilmaydi", async () => {
    vi.mocked(detectPlate).mockResolvedValue({
      detected: false,
      plate: null,
      confidence: 0,
      candidateFound: false,
    });

    const result = await entryAuto(orgId, null, "ZmFrZS1pbWFnZQ==");

    expect(result.detected).toBe(false);
    expect(result).toMatchObject({ reason: "no_candidate" });
    expect(saveParkingImage).not.toHaveBeenCalled();
    expect(emitParkingEntry).not.toHaveBeenCalled();
    expect(emitDetectionFailed).not.toHaveBeenCalled();
    expect(await activeSessionCount()).toBe(0);
  });
});

describe("entryAuto — candidate_found: true, detected: false (OCR o'qiy olmadi)", () => {
  it("rasm saqlanadi va detection_failed eventi yuboriladi — hozirgidek", async () => {
    vi.mocked(saveParkingImage).mockResolvedValue("uploads/parking/2026-07-20/fake.jpg");
    vi.mocked(detectPlate).mockResolvedValue({
      detected: false,
      plate: null,
      confidence: 0,
      candidateFound: true,
    });

    const result = await entryAuto(orgId, null, "ZmFrZS1pbWFnZQ==");

    expect(result.detected).toBe(false);
    expect(result).toMatchObject({ reason: "ocr_failed" });
    expect(saveParkingImage).toHaveBeenCalledTimes(1);
    expect(emitParkingEntry).toHaveBeenCalledWith(orgId, { session: null, detected: false });
    expect(emitDetectionFailed).toHaveBeenCalledWith(orgId, {
      type: "entry",
      image_url: "uploads/parking/2026-07-20/fake.jpg",
    });
    expect(await activeSessionCount()).toBe(0);
  });
});

describe("entryAuto — detected: true — regressiyasiz ishlaydi", () => {
  it("sessiya yaratiladi, rasm saqlanadi, faqat parking:entry eventi yuboriladi", async () => {
    vi.mocked(saveParkingImage).mockResolvedValue("uploads/parking/2026-07-20/plate.jpg");
    vi.mocked(detectPlate).mockResolvedValue({
      detected: true,
      plate: "01C400AA",
      confidence: 0.97,
      candidateFound: true,
    });

    const result = await entryAuto(orgId, null, "ZmFrZS1pbWFnZQ==");

    expect(result.detected).toBe(true);
    expect(result).not.toHaveProperty("reason");
    expect(saveParkingImage).toHaveBeenCalledTimes(1);
    expect(emitDetectionFailed).not.toHaveBeenCalled();
    expect(emitParkingEntry).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ detected: true })
    );
    expect(await activeSessionCount()).toBe(1);
  });
});

describe("exitAuto — candidate_found: false", () => {
  it("hech qanday websocket eventi yuborilmaydi, sessiya o'zgarmaydi", async () => {
    const plate = "01C500AA";
    await entryManual(operator, { plate_number: plate });

    vi.mocked(detectPlate).mockResolvedValue({
      detected: false,
      plate: null,
      confidence: 0,
      candidateFound: false,
    });

    const result = await exitAuto(orgId, null, "ZmFrZS1pbWFnZQ==");

    expect(result.detected).toBe(false);
    expect(result).toMatchObject({ reason: "no_candidate" });
    expect(saveParkingImage).not.toHaveBeenCalled();
    expect(emitParkingExit).not.toHaveBeenCalled();
    expect(emitDetectionFailed).not.toHaveBeenCalled();

    const [activeSession] = await db("tb_parking_sessions").where({ org_id: orgId, plate_number: plate });
    expect(activeSession.status).toBe("active");

    await exitManual(operator, { plate_number: plate });
  });
});

describe("exitAuto — candidate_found: true, detected: false", () => {
  it("reason: 'ocr_failed' qaytaradi va detection_failed eventi yuboriladi", async () => {
    const plate = "01C600AA";
    await entryManual(operator, { plate_number: plate });

    vi.mocked(saveParkingImage).mockResolvedValue("uploads/parking/2026-07-20/exit-fake.jpg");
    vi.mocked(detectPlate).mockResolvedValue({
      detected: false,
      plate: null,
      confidence: 0,
      candidateFound: true,
    });

    const result = await exitAuto(orgId, null, "ZmFrZS1pbWFnZQ==");

    expect(result.detected).toBe(false);
    expect(result).toMatchObject({ reason: "ocr_failed" });
    expect(saveParkingImage).toHaveBeenCalledTimes(1);
    expect(emitDetectionFailed).toHaveBeenCalledWith(orgId, {
      type: "exit",
      image_url: "uploads/parking/2026-07-20/exit-fake.jpg",
    });

    await exitManual(operator, { plate_number: plate });
  });
});
