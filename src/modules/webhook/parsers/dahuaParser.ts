import { CameraParser, CameraParserInput } from "./cameraParser.interface";
import { NormalizedCameraEvent } from "./normalizedCameraEvent";
import { UnsupportedCameraPayloadError } from "../webhookErrors";

export interface DahuaParseResult {
  plateNumber: string;
  deviceId: string | null;
  laneNumber: number | string | null;
  eventTime: Date;
  vehicleImageBase64: string | null;
  plateImageBase64: string | null;
  plateColor: string | null;
  plateRegion: string | null;
  vehicleBoundingBox: unknown;
  plateBoundingBox: unknown;
}

const EXPLICIT_PLATE_KEYS = [
  "PlateNumber",
  "PlateText",
  "License",
  "LicensePlate",
  "PlateNo",
  "PlateCode",
  "Text",
  "Value",
];

const FILENAME_PLATE_PATTERN = /^(.+?)-\d{14}(?:-plate)?\.\w+$/i;
const FILENAME_TIMESTAMP_PATTERN = /-(\d{14})(?:-plate)?\.\w+$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findByKey(node: unknown, key: string): unknown {
  if (isPlainObject(node)) {
    if (key in node) {
      return node[key];
    }
    for (const value of Object.values(node)) {
      const found = findByKey(value, key);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByKey(item, key);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function findStringByKey(node: unknown, key: string): string | undefined {
  if (isPlainObject(node)) {
    const direct = node[key];
    if (typeof direct === "string" && direct.trim() !== "") {
      return direct;
    }
    for (const value of Object.values(node)) {
      const found = findStringByKey(value, key);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findStringByKey(item, key);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function findFirstStringByKeys(node: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = findStringByKey(node, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function normalizePlateNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function stripDataUrlPrefix(value: string): string {
  const base64Marker = "base64,";
  const markerIndex = value.indexOf(base64Marker);
  if (value.startsWith("data:") && markerIndex !== -1) {
    return value.slice(markerIndex + base64Marker.length);
  }
  return value;
}

function extractPlateFromFilename(fileName: string): string | undefined {
  const match = FILENAME_PLATE_PATTERN.exec(fileName.trim());
  if (!match) {
    return undefined;
  }
  const normalized = normalizePlateNumber(match[1]);
  return normalized || undefined;
}

function extractTimestampFromFilename(fileName: string): Date | undefined {
  const match = FILENAME_TIMESTAMP_PATTERN.exec(fileName.trim());
  if (!match) {
    return undefined;
  }
  const digits = match[1];
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function extractExplicitEventTime(root: unknown): Date | undefined {
  const utc = findByKey(root, "UTC");
  if (typeof utc === "number" && Number.isFinite(utc)) {
    const date = new Date(utc * 1000);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return undefined;
}

function resolveRoot(rawBody: Buffer, parsedBody?: unknown): unknown {
  if (isPlainObject(parsedBody)) {
    return parsedBody;
  }
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function parseDahuaPayload(rawBody: Buffer, parsedBody?: unknown): DahuaParseResult | null {
  const root = resolveRoot(rawBody, parsedBody);
  if (!isPlainObject(root)) {
    return null;
  }

  const plateObj = findByKey(root, "Plate");
  if (isPlainObject(plateObj) && plateObj.IsExist === false) {
    return null;
  }

  const normalPic = findByKey(root, "NormalPic");
  const platePic = findByKey(root, "PlatePic");
  const snapInfo = findByKey(root, "SnapInfo");
  const vehicleObj = findByKey(root, "Vehicle");

  const platePicName = isPlainObject(platePic) && typeof platePic.PicName === "string" ? platePic.PicName : undefined;
  const normalPicName =
    isPlainObject(normalPic) && typeof normalPic.PicName === "string" ? normalPic.PicName : undefined;

  const explicitPlate = findFirstStringByKeys(root, EXPLICIT_PLATE_KEYS);

  let plateNumber = explicitPlate ? normalizePlateNumber(explicitPlate) || undefined : undefined;
  if (!plateNumber && platePicName) {
    plateNumber = extractPlateFromFilename(platePicName);
  }
  if (!plateNumber && normalPicName) {
    plateNumber = extractPlateFromFilename(normalPicName);
  }

  if (!plateNumber) {
    return null;
  }

  const eventTime =
    extractExplicitEventTime(root) ??
    (platePicName ? extractTimestampFromFilename(platePicName) : undefined) ??
    (normalPicName ? extractTimestampFromFilename(normalPicName) : undefined) ??
    new Date();

  const vehicleImageBase64 =
    isPlainObject(normalPic) && typeof normalPic.Content === "string"
      ? stripDataUrlPrefix(normalPic.Content)
      : null;
  const plateImageBase64 =
    isPlainObject(platePic) && typeof platePic.Content === "string" ? stripDataUrlPrefix(platePic.Content) : null;

  return {
    plateNumber,
    deviceId: isPlainObject(snapInfo) && typeof snapInfo.DeviceID === "string" ? snapInfo.DeviceID : null,
    laneNumber:
      isPlainObject(snapInfo) && (typeof snapInfo.LanNo === "number" || typeof snapInfo.LanNo === "string")
        ? snapInfo.LanNo
        : null,
    eventTime,
    vehicleImageBase64,
    plateImageBase64,
    plateColor: isPlainObject(plateObj) && typeof plateObj.PlateColor === "string" ? plateObj.PlateColor : null,
    plateRegion: isPlainObject(plateObj) && typeof plateObj.Region === "string" ? plateObj.Region : null,
    vehicleBoundingBox: isPlainObject(vehicleObj) ? (vehicleObj.VehicleBoundingBox ?? null) : null,
    plateBoundingBox: isPlainObject(plateObj) ? (plateObj.BoundingBox ?? null) : null,
  };
}

export const dahuaParser: CameraParser = {
  async parse(input: CameraParserInput): Promise<NormalizedCameraEvent> {
    const result = parseDahuaPayload(input.rawBody, input.parsedBody);
    if (!result) {
      throw new UnsupportedCameraPayloadError("Dahua payload tanilmadi yoki plate raqami aniqlanmadi", {
        cameraBrand: "dahua",
        contentType: input.contentType,
      });
    }

    return {
      plateNumber: result.plateNumber,
      confidence: null,
      timestamp: result.eventTime,
      direction: input.direction,
      cameraBrand: "dahua",
      deviceId: result.deviceId,
      vehicleImage: result.vehicleImageBase64 ? Buffer.from(result.vehicleImageBase64, "base64") : null,
      plateImage: result.plateImageBase64 ? Buffer.from(result.plateImageBase64, "base64") : null,
      metadata: {
        laneNumber: result.laneNumber,
        plateColor: result.plateColor,
        plateRegion: result.plateRegion,
        vehicleBoundingBox: result.vehicleBoundingBox,
        plateBoundingBox: result.plateBoundingBox,
      },
    };
  },
};
