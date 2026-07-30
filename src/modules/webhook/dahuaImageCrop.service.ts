import sharp from "sharp";
import { normalizeBoundingBox, padBoundingBox, NormalizedBoundingBox } from "@/utils/boundingBox";

// Dahua ITC413 overview frames are typically 2688x1584 (~4.3MP); 25MP gives
// generous headroom while still rejecting decompression-bomb-style inputs.
const MAX_INPUT_PIXELS = 25_000_000;

// Below these sizes a crop is not useful for an operator/audit review.
const VEHICLE_MIN_WIDTH = 64;
const VEHICLE_MIN_HEIGHT = 48;
const PLATE_MIN_WIDTH = 16;
const PLATE_MIN_HEIGHT = 8;

// Small margin so the crop does not clip the vehicle/plate edges.
const VEHICLE_PADDING_RATIO = 0.05;
const PLATE_PADDING_RATIO = 0.025;

const CROP_JPEG_QUALITY = 90;

export type VehicleImageSource = "normal_vehicle_bbox_crop" | "normal_fallback" | "none";
export type PlateImageSource = "plate_pic" | "cutout_pic" | "normal_plate_bbox_crop" | "none";

export interface DahuaImageCropInput {
  overviewImage: Buffer | null;
  platePicImage: Buffer | null;
  cutoutImage: Buffer | null;
  vehicleBoundingBoxRaw: unknown;
  plateBoundingBoxRaw: unknown;
}

export interface DahuaImageCropResult {
  overviewImage: Buffer | null;
  overviewWidth: number | null;
  overviewHeight: number | null;
  vehicleImage: Buffer | null;
  vehicleWidth: number | null;
  vehicleHeight: number | null;
  vehicleSource: VehicleImageSource;
  vehicleFallbackReason: string | null;
  normalizedVehicleBoundingBox: NormalizedBoundingBox | null;
  plateImage: Buffer | null;
  plateWidth: number | null;
  plateHeight: number | null;
  plateSource: PlateImageSource;
  normalizedPlateBoundingBox: NormalizedBoundingBox | null;
}

interface ImageMetadata {
  width: number;
  height: number;
  format: string;
}

async function safeMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  try {
    const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) return null;
    return { width: metadata.width, height: metadata.height, format: metadata.format ?? "jpeg" };
  } catch {
    return null;
  }
}

async function cropRegion(buffer: Buffer, box: NormalizedBoundingBox, format: string): Promise<Buffer | null> {
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).extract({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    });
    return format === "png" ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality: CROP_JPEG_QUALITY }).toBuffer();
  } catch {
    return null;
  }
}

async function withMetadata(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  const metadata = await safeMetadata(buffer);
  return { width: metadata?.width ?? null, height: metadata?.height ?? null };
}

export async function buildDahuaEventImages(input: DahuaImageCropInput): Promise<DahuaImageCropResult> {
  const result: DahuaImageCropResult = {
    overviewImage: null,
    overviewWidth: null,
    overviewHeight: null,
    vehicleImage: null,
    vehicleWidth: null,
    vehicleHeight: null,
    vehicleSource: "none",
    vehicleFallbackReason: null,
    normalizedVehicleBoundingBox: null,
    plateImage: null,
    plateWidth: null,
    plateHeight: null,
    plateSource: "none",
    normalizedPlateBoundingBox: null,
  };

  const overviewMeta = input.overviewImage ? await safeMetadata(input.overviewImage) : null;
  if (input.overviewImage && overviewMeta) {
    result.overviewImage = input.overviewImage;
    result.overviewWidth = overviewMeta.width;
    result.overviewHeight = overviewMeta.height;

    const vehicleBox = normalizeBoundingBox(input.vehicleBoundingBoxRaw, overviewMeta.width, overviewMeta.height, {
      minWidth: VEHICLE_MIN_WIDTH,
      minHeight: VEHICLE_MIN_HEIGHT,
    });

    if (!vehicleBox) {
      result.vehicleImage = result.overviewImage;
      result.vehicleWidth = overviewMeta.width;
      result.vehicleHeight = overviewMeta.height;
      result.vehicleSource = "normal_fallback";
      result.vehicleFallbackReason = "missing_or_invalid_bbox";
    } else {
      const padded = padBoundingBox(vehicleBox, overviewMeta.width, overviewMeta.height, VEHICLE_PADDING_RATIO);
      const crop = await cropRegion(result.overviewImage, padded, overviewMeta.format);
      if (crop) {
        result.vehicleImage = crop;
        result.vehicleWidth = padded.width;
        result.vehicleHeight = padded.height;
        result.vehicleSource = "normal_vehicle_bbox_crop";
        result.normalizedVehicleBoundingBox = padded;
      } else {
        result.vehicleImage = result.overviewImage;
        result.vehicleWidth = overviewMeta.width;
        result.vehicleHeight = overviewMeta.height;
        result.vehicleSource = "normal_fallback";
        result.vehicleFallbackReason = "crop_failed";
      }
    }
  }

  if (input.platePicImage) {
    result.plateImage = input.platePicImage;
    result.plateSource = "plate_pic";
    const { width, height } = await withMetadata(input.platePicImage);
    result.plateWidth = width;
    result.plateHeight = height;
  } else if (input.cutoutImage) {
    result.plateImage = input.cutoutImage;
    result.plateSource = "cutout_pic";
    const { width, height } = await withMetadata(input.cutoutImage);
    result.plateWidth = width;
    result.plateHeight = height;
  } else if (result.overviewImage && overviewMeta) {
    const plateBox = normalizeBoundingBox(input.plateBoundingBoxRaw, overviewMeta.width, overviewMeta.height, {
      minWidth: PLATE_MIN_WIDTH,
      minHeight: PLATE_MIN_HEIGHT,
    });
    if (plateBox) {
      const padded = padBoundingBox(plateBox, overviewMeta.width, overviewMeta.height, PLATE_PADDING_RATIO);
      const crop = await cropRegion(result.overviewImage, padded, overviewMeta.format);
      if (crop) {
        result.plateImage = crop;
        result.plateWidth = padded.width;
        result.plateHeight = padded.height;
        result.plateSource = "normal_plate_bbox_crop";
        result.normalizedPlateBoundingBox = padded;
      }
    }
  }

  return result;
}
