import { CameraParser, CameraParserInput } from "./cameraParser.interface";
import { NormalizedCameraEvent } from "./normalizedCameraEvent";
import { PlateNotFoundError, UnsupportedCameraPayloadError } from "../webhookErrors";

export interface HikvisionParseResult {
  plateNumber: string;
  confidence: number | null;
  timestamp: Date | null;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match ? match[1] : null;
}

function splitMultipartParts(rawBody: Buffer, boundary: string): Buffer[] {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];

  let start = rawBody.indexOf(boundaryMarker);
  while (start !== -1) {
    const next = rawBody.indexOf(boundaryMarker, start + boundaryMarker.length);
    if (next === -1) break;
    parts.push(rawBody.subarray(start + boundaryMarker.length, next));
    start = next;
  }

  return parts;
}

function findXmlText(candidates: string[]): string | null {
  return (
    candidates.find(
      (text) => text.includes("<EventNotificationAlert") || text.includes("<licensePlate>")
    ) ?? null
  );
}

export function extractHikvisionXmlText(rawBody: Buffer, contentType: string): string | null {
  if (contentType.includes("multipart/form-data")) {
    const boundary = extractBoundary(contentType);
    if (!boundary) return null;
    const parts = splitMultipartParts(rawBody, boundary).map((part) => part.toString("utf8"));
    return findXmlText(parts);
  }

  return findXmlText([rawBody.toString("utf8")]);
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1].trim() : null;
}

export function parseHikvisionPayload(contentType: string, rawBody: Buffer): HikvisionParseResult | null {
  const xmlText = extractHikvisionXmlText(rawBody, contentType);
  if (!xmlText) return null;

  const plateNumber = extractTag(xmlText, "licensePlate");
  if (!plateNumber) return null;

  const confidenceRaw = extractTag(xmlText, "confidenceLevel");
  const confidence = confidenceRaw !== null ? Number(confidenceRaw) : null;

  const dateTimeRaw = extractTag(xmlText, "dateTime");
  const parsedDate = dateTimeRaw !== null ? new Date(dateTimeRaw) : null;

  return {
    plateNumber,
    confidence: confidence !== null && !Number.isNaN(confidence) ? confidence : null,
    timestamp: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
  };
}

export const hikvisionParser: CameraParser = {
  async parse(input: CameraParserInput): Promise<NormalizedCameraEvent> {
    const xmlText = extractHikvisionXmlText(input.rawBody, input.contentType);
    if (!xmlText) {
      throw new UnsupportedCameraPayloadError("Hikvision XML payload topilmadi yoki formati tanilmadi", {
        cameraBrand: "hikvision",
        contentType: input.contentType,
      });
    }

    const parsed = parseHikvisionPayload(input.contentType, input.rawBody);
    if (!parsed) {
      throw new PlateNotFoundError("Hikvision payload tanildi, lekin licensePlate topilmadi", {
        cameraBrand: "hikvision",
        contentType: input.contentType,
      });
    }

    return {
      plateNumber: parsed.plateNumber,
      confidence: parsed.confidence,
      timestamp: parsed.timestamp,
      direction: input.direction,
      cameraBrand: "hikvision",
      rawPayload: xmlText,
    };
  },
};
