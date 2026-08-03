import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { dahuaParser, parseDahuaPayload } from "@/modules/webhook/parsers/dahuaParser";

const NORMAL_PIC_NAME = "10R726ZA-20260728150625.jpg";
const CUTOUT_PIC_NAME = "10R726ZA-20260728150625-cutout.jpg";
const PLATE_PIC_NAME = "10R726ZA-20260728150625-plate.jpg";
const NORMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xd9]).toString("base64");
const CUTOUT_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x02, 0xd9]).toString("base64");
const PLATE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x03, 0xd9]).toString("base64");

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 100, g: 100, b: 100 } } })
    .jpeg()
    .toBuffer();
}

function buildFixture(overrides: Record<string, unknown> = {}) {
  return {
    NormalPic: {
      Content: NORMAL_JPEG,
      PicName: NORMAL_PIC_NAME,
    },
    PlatePic: {
      Content: PLATE_JPEG,
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
  it.each([
    [95, 95],
    ["95", 95],
    [95.5, 95.5],
    ["95.5", 95.5],
  ])("Plate.Confidence %p qiymatini ajratadi", (confidence, expected) => {
    const fixture = buildFixture({
      Plate: { IsExist: true, PlateNumber: "10R726ZA", Confidence: confidence },
    });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.confidence).toBe(expected);
  });

  it("Plate.PlateConfidence va Plate.RecognitionConfidence ni qo'llab-quvvatlaydi", () => {
    const plateConfidenceFixture = buildFixture({
      Plate: { IsExist: true, PlateNumber: "10R726ZA", PlateConfidence: "91.25" },
    });
    const recognitionFixture = buildFixture({
      Plate: { IsExist: true, PlateNumber: "10R726ZA", RecognitionConfidence: 89 },
    });
    expect(
      parseDahuaPayload(Buffer.from(JSON.stringify(plateConfidenceFixture)), plateConfidenceFixture)?.confidence
    ).toBe(91.25);
    expect(
      parseDahuaPayload(Buffer.from(JSON.stringify(recognitionFixture)), recognitionFixture)?.confidence
    ).toBe(89);
  });

  it("Plate confidence generic va vehicle confidence'dan ustun turadi", () => {
    const fixture = buildFixture({
      Confidence: 12,
      Result: { Confidence: 22 },
      Vehicle: { Confidence: 99 },
      Plate: { IsExist: true, PlateNumber: "10R726ZA", Confidence: 94 },
    });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.confidence).toBe(94);
  });

  it.each([-1, 101, "NaN", "Infinity", "", null])(
    "yaroqsiz Plate.Confidence %p qiymatini null qiladi",
    (confidence) => {
      const fixture = buildFixture({
        Result: { Confidence: 88 },
        Plate: { IsExist: true, PlateNumber: "10R726ZA", Confidence: confidence },
      });
      const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
      expect(result?.confidence).toBeNull();
    }
  );

  it.each([
    [{ PlateInfo: { Confidence: "87" } }, 87],
    [{ Result: { Confidence: 86 } }, 86],
    [{ Event: { Confidence: "85.5" } }, 85.5],
    [{ Confidence: 84 }, 84],
    [{ body: { Confidence: "83" } }, 83],
    [{ data: { result: { Confidence: 82 } } }, 82],
  ])("Dahua confidence konteksti %p ni qo'llab-quvvatlaydi", (extra, expected) => {
    const fixture = buildFixture(extra);
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.confidence).toBe(expected);
  });

  it("confidence yo'q bo'lsa null saqlanadi", () => {
    const fixture = buildFixture();
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.confidence).toBeNull();
  });

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

  it("base64 rasmlarni to'g'ri manbalarga ajratadi", () => {
    const fixture = buildFixture({
      NormalPic: { Content: `data:image/jpeg;base64,${NORMAL_JPEG}`, PicName: NORMAL_PIC_NAME },
      CutoutPic: { Content: CUTOUT_JPEG, PicName: CUTOUT_PIC_NAME },
      PlatePic: { Content: PLATE_JPEG, PicName: PLATE_PIC_NAME },
    });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.overviewImageBase64).toBe(NORMAL_JPEG);
    expect(result?.cutoutImageBase64).toBe(CUTOUT_JPEG);
    expect(result?.platePicImageBase64).toBe(PLATE_JPEG);
    expect(result?.overviewImageFileName).toBe(NORMAL_PIC_NAME);
    expect(result?.cutoutImageFileName).toBe(CUTOUT_PIC_NAME);
    expect(result?.platePicFileName).toBe(PLATE_PIC_NAME);
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

  it("Plate.IsExist false va snapshot rasmlari bo'lsa plateNumber=null event qaytaradi", () => {
    const fixture = buildFixture({ Plate: { IsExist: false } });
    const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
    expect(result?.plateNumber).toBeNull();
    expect(result?.overviewImageBase64).toBe(NORMAL_JPEG);
  });

  it("explicit plate bo'sh yoki normalizatsiyada bo'sh bo'lsa filename'dan fake plate olmaydi", () => {
    for (const PlateNumber of ["", "---"]) {
      const fixture = buildFixture({ Plate: { IsExist: true, PlateNumber } });
      const result = parseDahuaPayload(Buffer.from(JSON.stringify(fixture)), fixture);
      expect(result?.plateNumber).toBeNull();
    }
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

describe("dahuaParser (CameraParser) — rasm semantikasi", () => {
  it("to'g'ri Dahua payloadidan NormalizedCameraEvent qaytaradi", async () => {
    const fixture = buildFixture();
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateNumber).toBe("10R726ZA");
    expect(event.cameraBrand).toBe("dahua");
    expect(event.deviceId).toBe("device-001");
    expect(event.confidence).toBeNull();
  });

  it("NormalPic -> overviewImage bo'ladi", async () => {
    const overview = await makeJpeg(200, 150);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: undefined,
      PlatePic: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.overviewImage).toEqual(overview);
    expect(event.metadata?.overviewImageSource).toBe("normal_pic");
  });

  it("CutoutPic -> plateImage bo'ladi, vehicleImage BO'LMAYDI", async () => {
    const overview = await makeJpeg(200, 150);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      CutoutPic: { Content: CUTOUT_JPEG, PicName: CUTOUT_PIC_NAME },
      PlatePic: undefined,
      Vehicle: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateImage).toEqual(Buffer.from(CUTOUT_JPEG, "base64"));
    expect(event.plateImage).not.toEqual(event.vehicleImage);
    expect(event.metadata?.plateImageSource).toBe("cutout_pic");
    expect(event.metadata?.vehicleImageSource).not.toBe("cutout_pic");
  });

  it("PlatePic mavjud bo'lsa CutoutPic'dan ustun turadi", async () => {
    const overview = await makeJpeg(200, 150);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      CutoutPic: { Content: CUTOUT_JPEG, PicName: CUTOUT_PIC_NAME },
      PlatePic: { Content: PLATE_JPEG, PicName: PLATE_PIC_NAME },
      Vehicle: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateImage).toEqual(Buffer.from(PLATE_JPEG, "base64"));
    expect(event.metadata?.plateImageSource).toBe("plate_pic");
  });

  it("PlatePic yo'q bo'lsa CutoutPic plate fallback bo'ladi", async () => {
    const overview = await makeJpeg(200, 150);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      CutoutPic: { Content: CUTOUT_JPEG, PicName: CUTOUT_PIC_NAME },
      PlatePic: undefined,
      Vehicle: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateImage).toEqual(Buffer.from(CUTOUT_JPEG, "base64"));
    expect(event.metadata?.plateImageSource).toBe("cutout_pic");
  });

  it("PlatePic va CutoutPic yo'q bo'lsa Plate.BoundingBox orqali NormalPic'dan kesiladi", async () => {
    const overview = await makeJpeg(400, 300);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      CutoutPic: undefined,
      PlatePic: undefined,
      Vehicle: undefined,
      Plate: { IsExist: true, PlateNumber: "10R726ZA", BoundingBox: { Left: 50, Top: 50, Right: 150, Bottom: 100 } },
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateImage).toBeTruthy();
    expect(event.metadata?.plateImageSource).toBe("normal_plate_bbox_crop");
  });

  it("noto'g'ri Plate.BoundingBox bo'lsa plateImage null bo'ladi", async () => {
    const overview = await makeJpeg(400, 300);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      CutoutPic: undefined,
      PlatePic: undefined,
      Vehicle: undefined,
      Plate: { IsExist: true, PlateNumber: "10R726ZA", BoundingBox: { Left: 0, Top: 0, Right: 0, Bottom: 0 } },
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateImage).toBeNull();
    expect(event.metadata?.plateImageSource).toBe("none");
  });

  it("Vehicle.VehicleBoundingBox orqali NormalPic'dan vehicle crop yaratadi", async () => {
    const overview = await makeJpeg(400, 300);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 300, Bottom: 250 } },
      CutoutPic: undefined,
      PlatePic: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.vehicleImage).toBeTruthy();
    expect(event.vehicleImage).not.toEqual(event.overviewImage);
    expect(event.metadata?.vehicleImageSource).toBe("normal_vehicle_bbox_crop");
    const meta = await sharp(event.vehicleImage!).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  it("bbox yo'q yoki yaroqsiz bo'lsa vehicleImage yaratilmaydi", async () => {
    const overview = await makeJpeg(200, 150);
    const missingBbox = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: undefined,
      CutoutPic: undefined,
      PlatePic: undefined,
    });
    const missing = await dahuaParser.parse(buildInput(missingBbox));
    expect(missing.vehicleImage).toBeNull();
    expect(missing.metadata?.vehicleImageSource).toBe("none");
    expect(missing.metadata?.vehicleFallbackReason).toBe("missing_or_invalid_bbox");

    const invalidBbox = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: { VehicleBoundingBox: { Left: 0, Top: 0, Right: 0, Bottom: 0 } },
      CutoutPic: undefined,
      PlatePic: undefined,
    });
    const invalid = await dahuaParser.parse(buildInput(invalidBbox));
    expect(invalid.vehicleImage).toBeNull();
    expect(invalid.metadata?.vehicleImageSource).toBe("none");
  });

  it("invalid va bo'sh rasmlar null bo'ladi, webhook qulamaydi", async () => {
    const fixture = buildFixture({
      NormalPic: { Content: "", PicName: NORMAL_PIC_NAME },
      CutoutPic: { Content: "AAAA", PicName: CUTOUT_PIC_NAME },
      PlatePic: { Content: "not-base64", PicName: PLATE_PIC_NAME },
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.overviewImage).toBeNull();
    expect(event.vehicleImage).toBeNull();
    expect(event.plateImage).toBeNull();
  });

  it("buzuq NormalPic webhookni qulatmaydi, overview/vehicle null bo'ladi", async () => {
    const corruptJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("bu jpeg emas ichida")]);
    const fixture = buildFixture({
      NormalPic: { Content: corruptJpeg.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: { VehicleBoundingBox: { Left: 5, Top: 6, Right: 100, Bottom: 100 } },
      CutoutPic: undefined,
      PlatePic: undefined,
    });
    await expect(dahuaParser.parse(buildInput(fixture))).resolves.toMatchObject({
      overviewImage: null,
      vehicleImage: null,
      plateImage: null,
    });
  });

  it("rasmli no-plate event unknown payload emas", async () => {
    const overview = await makeJpeg(200, 150);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Plate: { IsExist: false },
    });
    const event = await dahuaParser.parse(buildInput(fixture, { direction: "exit" }));
    expect(event.plateNumber).toBeNull();
    expect(event.metadata?.eventKind).toBe("plate_not_recognized");
    expect(event.overviewImage).toBeTruthy();
  });

  it("no-plate eventda ham Vehicle bbox orqali vehicle crop yaratiladi", async () => {
    const overview = await makeJpeg(400, 300);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: { VehicleBoundingBox: { Left: 20, Top: 20, Right: 300, Bottom: 250 } },
      CutoutPic: { Content: CUTOUT_JPEG, PicName: "noplate-20260728150625-plate.jpg" },
      PlatePic: undefined,
      Plate: { IsExist: false },
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.plateNumber).toBeNull();
    expect(event.metadata?.vehicleImageSource).toBe("normal_vehicle_bbox_crop");
    expect(event.plateImage).toEqual(Buffer.from(CUTOUT_JPEG, "base64"));
  });

  it("Dahua confidence NormalizedCameraEvent'ga uzatiladi", async () => {
    const fixture = buildFixture({
      Plate: { IsExist: true, PlateNumber: "10R726ZA", Confidence: "94.5" },
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.confidence).toBe(94.5);
  });

  it("tanilmagan payload uchun UnsupportedCameraPayloadError tashlaydi", async () => {
    await expect(
      dahuaParser.parse(buildInput({ foo: "bar" }, { rawBody: Buffer.from("bu dahua emas") }))
    ).rejects.toMatchObject({ code: "unsupported_camera_payload" });
  });

  it.each([
    { Active: "keepAlive", DeviceID: "dev-1" },
    { body: { Active: "keepAlive", DeviceID: "dev-1" } },
    { payload: { Active: "keepAlive", DeviceID: "dev-1" } },
    { DeviceID: "dev-1", DeviceModel: "ITC413", DeviceType: "Tollgate", Manufacturer: "Dahua" },
    { Plate: { IsExist: false }, DeviceID: "dev-1" },
  ])("kutilgan xizmat signalini ignored xatosi bilan ajratadi", async (fixture) => {
    await expect(dahuaParser.parse(buildInput(fixture))).rejects.toMatchObject({
      name: "IgnoredCameraSignalError",
    });
  });
});

describe("dahuaParser — real production-style tasvirlar", () => {
  it("2688x1584 NormalPic, [1409,69,2669,779] vehicle bbox, [1294,635,1546,769] plate bbox va 96x32 CutoutPic", async () => {
    const overview = await makeJpeg(2688, 1584);
    const cutout = await makeJpeg(96, 32);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: "85J119PA-20260728175503.jpg" },
      CutoutPic: { Content: cutout.toString("base64"), PicName: "85J119PA-20260728175503-plate.jpg" },
      PlatePic: undefined,
      Vehicle: { VehicleBoundingBox: [1409, 69, 2669, 779] },
      Plate: {
        IsExist: true,
        PlateNumber: "85J119PA",
        BoundingBox: [1294, 635, 1546, 769],
      },
    });
    const event = await dahuaParser.parse(buildInput(fixture));

    const overviewMeta = await sharp(event.overviewImage!).metadata();
    expect(overviewMeta.width).toBe(2688);
    expect(overviewMeta.height).toBe(1584);

    const vehicleMeta = await sharp(event.vehicleImage!).metadata();
    expect(vehicleMeta.width).toBeGreaterThan(90);
    expect(vehicleMeta.height).toBeGreaterThan(90);
    expect(event.vehicleImage).not.toEqual(Buffer.from(cutout));

    const plateMeta = await sharp(event.plateImage!).metadata();
    expect(plateMeta.width).toBe(96);
    expect(plateMeta.height).toBe(32);
    expect(event.plateImage).toEqual(cutout);

    expect(event.metadata?.vehicleImageSource).toBe("normal_vehicle_bbox_crop");
    expect(event.metadata?.plateImageSource).toBe("cutout_pic");
  });

  it("string koordinatali bbox qo'llab-quvvatlanadi", async () => {
    const overview = await makeJpeg(2688, 1584);
    const fixture = buildFixture({
      NormalPic: { Content: overview.toString("base64"), PicName: NORMAL_PIC_NAME },
      Vehicle: { VehicleBoundingBox: ["1409", "69", "2669", "779"] },
      CutoutPic: undefined,
      PlatePic: undefined,
    });
    const event = await dahuaParser.parse(buildInput(fixture));
    expect(event.metadata?.vehicleImageSource).toBe("normal_vehicle_bbox_crop");
  });
});
