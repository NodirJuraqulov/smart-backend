import { CameraParser, CameraParserInput } from "./cameraParser.interface";
import { NormalizedCameraEvent } from "./normalizedCameraEvent";
import { IgnoredCameraSignalError, UnsupportedCameraPayloadError } from "../webhookErrors";

export interface DahuaParseResult {
  plateNumber: string | null;
  confidence: number | null;
  deviceId: string | null;
  laneNumber: number | string | null;
  eventTime: Date;
  overviewImageBase64: string | null;
  vehicleImageBase64: string | null;
  plateImageBase64: string | null;
  plateColor: string | null;
  plateRegion: string | null;
  vehicleBoundingBox: unknown;
  plateBoundingBox: unknown;
  overviewImageFileName: string | null;
  vehicleImageFileName: string | null;
  plateImageFileName: string | null;
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

function hasExplicitPlateField(root: Record<string, unknown>, plate: unknown): boolean {
  if (
    isPlainObject(plate) &&
    EXPLICIT_PLATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(plate, key))
  ) {
    return true;
  }
  const candidates: unknown[] = [root];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isPlainObject(candidate)) continue;
    if (EXPLICIT_PLATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(candidate, key))) {
      return true;
    }
    for (const key of ["body", "data", "result"]) {
      if (isPlainObject(candidate[key])) candidates.push(candidate[key]);
    }
  }
  return false;
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

function isIgnoredServiceSignal(root: unknown): boolean {
  if (!isPlainObject(root)) return false;

  const active = findByKey(root, "Active");
  if (typeof active === "string" && active.toLowerCase() === "keepalive") return true;

  const plate = findByKey(root, "Plate");
  const hasSnapshotImage = ["NormalPic", "CutoutPic", "PlatePic"].some((key) =>
    isPlainObject(findByKey(root, key))
  );
  if (isPlainObject(plate) && plate.IsExist === false && !hasSnapshotImage) return true;

  const hasDeviceId = typeof findByKey(root, "DeviceID") === "string";
  const serviceKeys = ["DeviceModel", "DeviceName", "DeviceType", "IPAddress", "Manufacturer", "Status", "Heartbeat"];
  return hasDeviceId &&
    serviceKeys.some((key) => findByKey(root, key) !== undefined) &&
    plate === undefined;
}

function imageContent(image: unknown): string | null {
  if (!isPlainObject(image) || typeof image.Content !== "string") return null;
  const content = stripDataUrlPrefix(image.Content.trim()).trim();
  return content || null;
}

function decodeImageBase64(value: string | null): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length) return null;
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  return isJpeg || isPng ? buffer : null;
}

function parseDahuaDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeConfidence(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const confidence = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 100 ? confidence : null;
}

function directConfidence(
  node: unknown,
  keys: string[]
): { found: boolean; value: number | null } {
  if (!isPlainObject(node)) return { found: false, value: null };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      return { found: true, value: normalizeConfidence(node[key]) };
    }
  }
  return { found: false, value: null };
}

function extractConfidence(root: Record<string, unknown>): number | null {
  const plate = findByKey(root, "Plate");
  const plateConfidence = directConfidence(plate, [
    "Confidence",
    "PlateConfidence",
    "RecognitionConfidence",
  ]);
  if (plateConfidence.found) return plateConfidence.value;

  const plateInfoConfidence = directConfidence(findByKey(root, "PlateInfo"), ["Confidence"]);
  if (plateInfoConfidence.found) return plateInfoConfidence.value;

  const resultConfidence = directConfidence(findByKey(root, "Result"), ["Confidence"]);
  if (resultConfidence.found) return resultConfidence.value;

  const eventConfidence = directConfidence(findByKey(root, "Event"), ["Confidence"]);
  if (eventConfidence.found) return eventConfidence.value;

  const wrapperCandidates: unknown[] = [root];
  for (let index = 0; index < wrapperCandidates.length; index += 1) {
    const candidate = wrapperCandidates[index];
    if (!isPlainObject(candidate)) continue;
    const confidence = directConfidence(candidate, ["Confidence"]);
    if (confidence.found) return confidence.value;
    for (const key of ["body", "data", "result"]) {
      if (isPlainObject(candidate[key])) wrapperCandidates.push(candidate[key]);
    }
  }
  return null;
}

export function parseDahuaPayload(rawBody: Buffer, parsedBody?: unknown): DahuaParseResult | null {
  const root = resolveRoot(rawBody, parsedBody);
  if (!isPlainObject(root)) {
    return null;
  }

  const plateObj = findByKey(root, "Plate");

  const normalPic = findByKey(root, "NormalPic");
  const cutoutPic = findByKey(root, "CutoutPic");
  const platePic = findByKey(root, "PlatePic");
  const snapInfo = findByKey(root, "SnapInfo");
  const vehicleObj = findByKey(root, "Vehicle");

  const platePicName = isPlainObject(platePic) && typeof platePic.PicName === "string" ? platePic.PicName : undefined;
  const normalPicName =
    isPlainObject(normalPic) && typeof normalPic.PicName === "string" ? normalPic.PicName : undefined;
  const cutoutPicName =
    isPlainObject(cutoutPic) && typeof cutoutPic.PicName === "string" ? cutoutPic.PicName : undefined;

  const explicitPlate = findFirstStringByKeys(root, EXPLICIT_PLATE_KEYS);
  const normalizedExplicitPlate = explicitPlate
    ? normalizePlateNumber(explicitPlate) || undefined
    : undefined;
  const plateHasExplicitKey = hasExplicitPlateField(root, plateObj);
  const plateExplicitlyMissing =
    (isPlainObject(plateObj) && plateObj.IsExist === false) ||
    (plateHasExplicitKey && !normalizedExplicitPlate);

  let plateNumber = normalizedExplicitPlate;
  if (!plateNumber && !plateExplicitlyMissing && platePicName) {
    plateNumber = extractPlateFromFilename(platePicName);
  }
  if (!plateNumber && !plateExplicitlyMissing && normalPicName) {
    plateNumber = extractPlateFromFilename(normalPicName);
  }
  if (!plateNumber && !plateExplicitlyMissing && cutoutPicName) {
    plateNumber = extractPlateFromFilename(cutoutPicName);
  }

  const hasAnprStructure =
    isPlainObject(plateObj) ||
    isPlainObject(snapInfo) ||
    isPlainObject(normalPic) ||
    isPlainObject(cutoutPic) ||
    isPlainObject(platePic);
  if (!plateNumber && !hasAnprStructure) {
    return null;
  }

  const eventTime =
    extractExplicitEventTime(root) ??
    parseDahuaDate(isPlainObject(snapInfo) ? snapInfo.AccurateTime : undefined) ??
    parseDahuaDate(isPlainObject(snapInfo) ? snapInfo.SnapTime : undefined) ??
    (platePicName ? extractTimestampFromFilename(platePicName) : undefined) ??
    (normalPicName ? extractTimestampFromFilename(normalPicName) : undefined) ??
    (cutoutPicName ? extractTimestampFromFilename(cutoutPicName) : undefined) ??
    new Date();

  const overviewImageBase64 = imageContent(normalPic);
  const cutoutImageBase64 = imageContent(cutoutPic);
  const vehicleImageBase64 = cutoutImageBase64 ?? overviewImageBase64;
  const plateImageBase64 = imageContent(platePic);

  return {
    plateNumber: plateNumber ?? null,
    confidence: extractConfidence(root),
    deviceId:
      isPlainObject(snapInfo) && typeof snapInfo.DeviceID === "string"
        ? snapInfo.DeviceID
        : findStringByKey(root, "DeviceID") ?? null,
    laneNumber:
      isPlainObject(snapInfo) && (typeof snapInfo.LanNo === "number" || typeof snapInfo.LanNo === "string")
        ? snapInfo.LanNo
        : null,
    eventTime,
    overviewImageBase64,
    vehicleImageBase64,
    plateImageBase64,
    plateColor: isPlainObject(plateObj) && typeof plateObj.PlateColor === "string" ? plateObj.PlateColor : null,
    plateRegion: isPlainObject(plateObj) && typeof plateObj.Region === "string" ? plateObj.Region : null,
    vehicleBoundingBox: isPlainObject(vehicleObj) ? (vehicleObj.VehicleBoundingBox ?? null) : null,
    plateBoundingBox: isPlainObject(plateObj) ? (plateObj.BoundingBox ?? null) : null,
    overviewImageFileName: normalPicName ?? null,
    vehicleImageFileName: cutoutImageBase64 ? cutoutPicName ?? null : normalPicName ?? null,
    plateImageFileName: platePicName ?? null,
  };
}

export const dahuaParser: CameraParser = {
  async parse(input: CameraParserInput): Promise<NormalizedCameraEvent> {
    const root = resolveRoot(input.rawBody, input.parsedBody);
    if (isIgnoredServiceSignal(root)) {
      throw new IgnoredCameraSignalError(undefined, { cameraBrand: "dahua" });
    }
    const result = parseDahuaPayload(input.rawBody, input.parsedBody);
    if (!result) {
      throw new UnsupportedCameraPayloadError("Dahua payload tanilmadi yoki plate raqami aniqlanmadi", {
        cameraBrand: "dahua",
        contentType: input.contentType,
      });
    }

    const overviewImage = decodeImageBase64(result.overviewImageBase64);
    const selectedVehicleImage = decodeImageBase64(result.vehicleImageBase64);
    const vehicleImage = selectedVehicleImage ?? overviewImage;
    const plateImage = decodeImageBase64(result.plateImageBase64);

    return {
      plateNumber: result.plateNumber,
      confidence: result.confidence,
      timestamp: result.eventTime,
      direction: input.direction,
      cameraBrand: "dahua",
      deviceId: result.deviceId,
      overviewImage,
      vehicleImage,
      plateImage,
      metadata: {
        laneNumber: result.laneNumber,
        plateColor: result.plateColor,
        plateRegion: result.plateRegion,
        vehicleBoundingBox: result.vehicleBoundingBox,
        plateBoundingBox: result.plateBoundingBox,
        eventKind: result.plateNumber ? "anpr" : "plate_not_recognized",
        vehicleImageSource:
          selectedVehicleImage && result.vehicleImageFileName !== result.overviewImageFileName
            ? "cutout"
            : overviewImage
              ? "normal_fallback"
              : null,
      },
      overviewImageFileName: result.overviewImageFileName,
      vehicleImageFileName:
        selectedVehicleImage ? result.vehicleImageFileName : overviewImage ? result.overviewImageFileName : null,
      plateImageFileName: result.plateImageFileName,
    };
  },
};
