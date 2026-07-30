import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildDahuaEventImages } from "@/modules/webhook/dahuaImageCrop.service";

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 80, g: 90, b: 100 } } })
    .jpeg()
    .toBuffer();
}

describe("buildDahuaEventImages", () => {
  it("bbox mavjud bo'lmasa vehicle uchun NormalPic fallback ishlatadi", async () => {
    const overview = await makeJpeg(300, 200);
    const result = await buildDahuaEventImages({
      overviewImage: overview,
      platePicImage: null,
      cutoutImage: null,
      vehicleBoundingBoxRaw: null,
      plateBoundingBoxRaw: null,
    });
    expect(result.vehicleImage).toEqual(overview);
    expect(result.vehicleSource).toBe("normal_fallback");
    expect(result.vehicleFallbackReason).toBe("missing_or_invalid_bbox");
    expect(result.plateSource).toBe("none");
    expect(result.plateImage).toBeNull();
  });

  it("yaroqli vehicle bbox orqali NormalPic'dan crop yaratadi", async () => {
    const overview = await makeJpeg(400, 300);
    const result = await buildDahuaEventImages({
      overviewImage: overview,
      platePicImage: null,
      cutoutImage: null,
      vehicleBoundingBoxRaw: [40, 40, 360, 280],
      plateBoundingBoxRaw: null,
    });
    expect(result.vehicleSource).toBe("normal_vehicle_bbox_crop");
    expect(result.vehicleImage).not.toEqual(overview);
    expect(result.vehicleImage).toBeTruthy();
    const meta = await sharp(result.vehicleImage!).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  it("PlatePic ustuvorligini saqlaydi", async () => {
    const overview = await makeJpeg(300, 200);
    const platePic = await makeJpeg(60, 20);
    const cutout = await makeJpeg(96, 32);
    const result = await buildDahuaEventImages({
      overviewImage: overview,
      platePicImage: platePic,
      cutoutImage: cutout,
      vehicleBoundingBoxRaw: null,
      plateBoundingBoxRaw: null,
    });
    expect(result.plateImage).toEqual(platePic);
    expect(result.plateSource).toBe("plate_pic");
  });

  it("PlatePic bo'lmasa CutoutPic'ga fallback qiladi", async () => {
    const cutout = await makeJpeg(96, 32);
    const result = await buildDahuaEventImages({
      overviewImage: null,
      platePicImage: null,
      cutoutImage: cutout,
      vehicleBoundingBoxRaw: null,
      plateBoundingBoxRaw: null,
    });
    expect(result.plateImage).toEqual(cutout);
    expect(result.plateSource).toBe("cutout_pic");
  });

  it("buzuq NormalPic bo'lsa qulamaydi, hammasi null bo'ladi", async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not a real jpeg body at all")]);
    const result = await buildDahuaEventImages({
      overviewImage: corrupt,
      platePicImage: null,
      cutoutImage: null,
      vehicleBoundingBoxRaw: [10, 10, 100, 100],
      plateBoundingBoxRaw: null,
    });
    expect(result.overviewImage).toBeNull();
    expect(result.vehicleImage).toBeNull();
    expect(result.vehicleSource).toBe("none");
  });

  it("juda katta (decompression-bomb-style) tasvirni xavfsiz rad etadi", async () => {
    const oversized = await sharp({
      create: { width: 5100, height: 5100, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .toBuffer();
    const result = await buildDahuaEventImages({
      overviewImage: oversized,
      platePicImage: null,
      cutoutImage: null,
      vehicleBoundingBoxRaw: [10, 10, 100, 100],
      plateBoundingBoxRaw: null,
    });
    expect(result.overviewImage).toBeNull();
    expect(result.vehicleImage).toBeNull();
  }, 20_000);

  it("crop uchun manfiy yoki chegaradan tashqari extract sharp'ga yuborilmaydi", async () => {
    const overview = await makeJpeg(100, 100);
    const result = await buildDahuaEventImages({
      overviewImage: overview,
      platePicImage: null,
      cutoutImage: null,
      vehicleBoundingBoxRaw: [-500, -500, 5000, 5000],
      plateBoundingBoxRaw: null,
    });
    expect(result.vehicleSource).toBe("normal_vehicle_bbox_crop");
    expect(result.normalizedVehicleBoundingBox?.left).toBeGreaterThanOrEqual(0);
    expect(result.normalizedVehicleBoundingBox?.top).toBeGreaterThanOrEqual(0);
    expect(result.normalizedVehicleBoundingBox?.right).toBeLessThanOrEqual(100);
    expect(result.normalizedVehicleBoundingBox?.bottom).toBeLessThanOrEqual(100);
  });
});
