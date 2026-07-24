import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entryAuto, entryManual, exitManual } from "@/modules/parking/parking.service";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { ApiError } from "@/utils/ApiError";
import { detectPlate } from "@/services/ocr.service";
import { saveParkingImage } from "@/utils/imageStorage";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
  createTestTariff,
  createTestUser,
} from "./helpers";

vi.mock("@/services/ocr.service", () => ({ detectPlate: vi.fn() }));
vi.mock("@/utils/imageStorage", () => ({ saveParkingImage: vi.fn() }));

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

describe("entryManual — duplicate himoyasi", () => {
  it("bir xil nomer, hali chiqmagan holda — rad etiladi (409)", async () => {
    const plate = "01A123AA";
    await entryManual(operator, { plate_number: plate });

    await expect(entryManual(operator, { plate_number: plate })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rad etish xatosi ApiError instansiyasi bo'lishi kerak", async () => {
    const plate = "01A124AA";
    await entryManual(operator, { plate_number: plate });

    await expect(entryManual(operator, { plate_number: plate })).rejects.toBeInstanceOf(ApiError);
  });

  it("bir xil nomer, chiqqandan keyin — YANGI kirish RUXSAT etiladi", async () => {
    const plate = "01A125AA";
    const first = await entryManual(operator, { plate_number: plate });

    await exitManual(operator, { plate_number: plate });

    const second = await entryManual(operator, { plate_number: plate });
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.status).toBe("active");
  });

  it("boshqa nomer bilan parallel faol sessiya — muammosiz ruxsat etiladi", async () => {
    await entryManual(operator, { plate_number: "01A200AA" });
    const other = await entryManual(operator, { plate_number: "01A201AA" });
    expect(other).toBeTruthy();
  });
});

describe("entryAuto — duplicate himoyasi (OCR mock orqali)", () => {
  it("bir xil aniqlangan nomer, hali chiqmagan holda — rad etiladi", async () => {
    const plate = "01A300AA";
    vi.mocked(saveParkingImage).mockResolvedValue("uploads/parking/fake.jpg");
    vi.mocked(detectPlate).mockResolvedValue({ detected: true, plate, confidence: 0.99, candidateFound: true });

    const first = await entryAuto(orgId, null, "ZmFrZS1pbWFnZQ==");
    expect(first.detected).toBe(true);

    await expect(entryAuto(orgId, null, "ZmFrZS1pbWFnZQ==")).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
