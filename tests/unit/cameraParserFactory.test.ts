import { describe, expect, it } from "vitest";
import { cameraParserFactory } from "@/modules/webhook/parsers/cameraParserFactory";
import { hikvisionParser } from "@/modules/webhook/parsers/hikvisionParser";
import { dahuaParser } from "@/modules/webhook/parsers/dahuaParser";
import { UnsupportedCameraBrandError } from "@/modules/webhook/webhookErrors";

describe("cameraParserFactory.getParser", () => {
  it("'hikvision' uchun hikvisionParser qaytaradi", () => {
    expect(cameraParserFactory.getParser("hikvision")).toBe(hikvisionParser);
  });

  it("'dahua' uchun dahuaParser qaytaradi", () => {
    expect(cameraParserFactory.getParser("dahua")).toBe(dahuaParser);
  });

  it("brend case-insensitive ishlaydi", () => {
    expect(cameraParserFactory.getParser("Hikvision")).toBe(hikvisionParser);
    expect(cameraParserFactory.getParser("HIKVISION")).toBe(hikvisionParser);
    expect(cameraParserFactory.getParser("  hikvision  ")).toBe(hikvisionParser);
    expect(cameraParserFactory.getParser("DAHUA")).toBe(dahuaParser);
  });

  it("noma'lum brend uchun UnsupportedCameraBrandError tashlaydi", () => {
    expect(() => cameraParserFactory.getParser("sony")).toThrow(UnsupportedCameraBrandError);
    expect(() => cameraParserFactory.getParser("sony")).toThrow("Unsupported camera brand: sony");
  });

  it("bo'sh brend uchun ham xato tashlaydi", () => {
    expect(() => cameraParserFactory.getParser("")).toThrow(UnsupportedCameraBrandError);
  });
});

describe("cameraParserFactory.isSupportedCameraBrand", () => {
  it("qo'llab-quvvatlanadigan brendlar uchun true qaytaradi", () => {
    expect(cameraParserFactory.isSupportedCameraBrand("hikvision")).toBe(true);
    expect(cameraParserFactory.isSupportedCameraBrand("Dahua")).toBe(true);
  });

  it("noma'lum brend uchun false qaytaradi", () => {
    expect(cameraParserFactory.isSupportedCameraBrand("sony")).toBe(false);
  });
});
