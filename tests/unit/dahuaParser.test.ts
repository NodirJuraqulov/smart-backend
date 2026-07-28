import { describe, expect, it } from "vitest";
import { dahuaParser, parseDahuaPayload } from "@/modules/webhook/parsers/dahuaParser";

const NORMAL_PIC_NAME = "10R726ZA-20260728150625.jpg";
const PLATE_PIC_NAME = "10R726ZA-20260728150625-plate.jpg";

function buildFixture(overrides: Record<string, unknown> = {}) {
  return {
    NormalPic: {
      Content: "AAAA",
      PicName: NORMAL_PIC_NAME,
    },
    PlatePic: {
      Content: "BBBB",
      PicName: PLATE_PIC_NAME,
    },
    Plate: {
      IsExist: true,
      BoundingBox: { Left: 1, Top: 2, Right: 3, Bottom: 4 },
      PlateColor: "Blue",
      PlateType: "Civil",
      Region: "Tashkent",
    },
    SnapInfo: {
      DeviceID: "device-001",
      LanNo: 1,
      Source: "Camera1",
      OpenStrobe: 1,
    },
    Vehicle: {
      VehicleBoundingBox: { Left: 5, Top: 6, Right: 7, Bottom: 8 },
    },
    ...overrides,
  };
}

function buildInput(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    parsedBody: body,
    headers: {},
    query: {},
    contentType: "application/json",
    direction: "entry" as const,
    organization: { id: 1, cameraBrand: "dahua" },
    ...overrides,
  };
}

describe("parseDahuaPayload", () => {
  it("NormalPic.PicName dan 10R726ZA ni ajratadi", () => {
    const fixture = buildFixture({ PlatePic: undefined });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("10R726ZA");
  });

  it("PlatePic.PicName dan 10R726ZA ni ajratadi", () => {
    const fixture = buildFixture({ NormalPic: undefined });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("10R726ZA");
  });

  it("aniq PlateNumber maydoni fayl nomidan ustun turadi", () => {
    const fixture = buildFixture({ PlateNumber: "01A777BB" });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("01A777BB");
  });

  it("fayl nomidan 2026-07-28 15:06:25 sanasini ajratadi", () => {
    const fixture = buildFixture();
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.eventTime.getFullYear()).toBe(2026);
    expect(result?.eventTime.getMonth()).toBe(6);
    expect(result?.eventTime.getDate()).toBe(28);
    expect(result?.eventTime.getHours()).toBe(15);
    expect(result?.eventTime.getMinutes()).toBe(6);
    expect(result?.eventTime.getSeconds()).toBe(25);
  });

  it("DeviceID ni ajratadi", () => {
    const fixture = buildFixture();
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.deviceId).toBe("device-001");
  });

  it("base64 rasmlarni ajratadi", () => {
    const fixture = buildFixture({
      NormalPic: { Content: "data:image/jpeg;base64,AAAA", PicName: NORMAL_PIC_NAME },
      PlatePic: { Content: "BBBB", PicName: PLATE_PIC_NAME },
    });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.vehicleImageBase64).toBe("AAAA");
    expect(result?.plateImageBase64).toBe("BBBB");
  });

  it("body ichiga o'ralgan payloadni qo'llab-quvvatlaydi", () => {
    const fixture = { body: buildFixture() };
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("10R726ZA");
  });

  it("data ichiga o'ralgan payloadni qo'llab-quvvatlaydi", () => {
    const fixture = { data: buildFixture() };
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("10R726ZA");
  });

  it("Plate.IsExist false bo'lsa null qaytaradi", () => {
    const fixture = buildFixture({ Plate: { IsExist: false } });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result).toBeNull();
  });

  it("ixtiyoriy maydonlar yo'q bo'lsa ham xato tashlamaydi", () => {
    const fixture = { NormalPic: { PicName: NORMAL_PIC_NAME } };
    expect(() => parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture)).not.toThrow();
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBe("10R726ZA");
    expect(result?.deviceId).toBeNull();
    expect(result?.plateColor).toBeNull();
  });
});

describe("dahuaParser (CameraParser)", () => {
  it("to'g'ri Dahua payloadidan NormalizedCameraEvent qaytaradi", async () => {
    const fixture = buildFixture();
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateNumber).toBe("10R726ZA");
    expect(event.cameraBrand).toBe("dahua");
    expect(event.deviceId).toBe("device-001");
  });

  it("tanilmagan payload uchun UnsupportedCameraPayloadError tashlaydi", async () => {
    await expect(
      dahuaParser.parse(buildInput({ foo: "bar" }, { rawBody: Buffer.from("bu dahua emas") }))
    ).rejects.toMatchObject({ code: "unsupported_camera_payload" });
  });
});
