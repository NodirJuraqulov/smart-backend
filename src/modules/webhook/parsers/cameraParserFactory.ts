import { CameraParser } from "./cameraParser.interface";
import { hikvisionParser } from "./hikvisionParser";
import { dahuaParser } from "./dahuaParser";
import { UnsupportedCameraBrandError } from "../webhookErrors";

const PARSERS: Record<string, CameraParser> = {
  hikvision: hikvisionParser,
  dahua: dahuaParser,
};

function normalizeCameraBrand(brand: string): string {
  return brand.trim().toLowerCase();
}

function getParser(cameraBrand: string): CameraParser {
  const parser = PARSERS[normalizeCameraBrand(cameraBrand)];
  if (!parser) {
    throw new UnsupportedCameraBrandError(cameraBrand);
  }
  return parser;
}

function isSupportedCameraBrand(cameraBrand: string): boolean {
  return normalizeCameraBrand(cameraBrand) in PARSERS;
}

export const cameraParserFactory = {
  getParser,
  isSupportedCameraBrand,
};
