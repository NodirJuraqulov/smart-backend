import { describe, expect, it } from "vitest";
import { parseHikvisionPayload } from "@/modules/webhook/hikvisionParser";

function buildMultipartBody(boundary: string, xml: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Type: application/xml; charset="UTF-8"\r\n\r\n${xml}\r\n--${boundary}--\r\n`
  );
}

const VALID_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  "<EventNotificationAlert>" +
  "<dateTime>2026-07-25T10:00:00+05:00</dateTime>" +
  "<ANPR><licensePlate>01A123AA</licensePlate><confidenceLevel>92</confidenceLevel></ANPR>" +
  "</EventNotificationAlert>";

describe("parseHikvisionPayload", () => {
  it("multipart/form-data ichidagi XML'ni to'g'ri parse qiladi", () => {
    const boundary = "TestBoundary123";
    const rawBody = buildMultipartBody(boundary, VALID_XML);
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const result = parseHikvisionPayload(contentType, rawBody);

    expect(result).not.toBeNull();
    expect(result?.plateNumber).toBe("01A123AA");
    expect(result?.confidence).toBe(92);
    expect(result?.timestamp?.toISOString()).toBe(new Date("2026-07-25T10:00:00+05:00").toISOString());
  });

  it("multipart bo'lmagan, xom XML tanani ham parse qiladi", () => {
    const result = parseHikvisionPayload("application/xml", Buffer.from(VALID_XML));

    expect(result?.plateNumber).toBe("01A123AA");
  });

  it("confidenceLevel yoki dateTime bo'lmasa ham licensePlate borligicha parse qiladi", () => {
    const xml = "<EventNotificationAlert><ANPR><licensePlate>77B777BB</licensePlate></ANPR></EventNotificationAlert>";
    const result = parseHikvisionPayload("application/xml", Buffer.from(xml));

    expect(result?.plateNumber).toBe("77B777BB");
    expect(result?.confidence).toBeNull();
    expect(result?.timestamp).toBeNull();
  });

  it("notanish formatda null qaytaradi", () => {
    const result = parseHikvisionPayload("text/plain", Buffer.from("bu hikvision formatida emas"));
    expect(result).toBeNull();
  });

  it("boundary'siz multipart content-type uchun null qaytaradi", () => {
    const result = parseHikvisionPayload("multipart/form-data", Buffer.from(VALID_XML));
    expect(result).toBeNull();
  });

  it("licensePlate topilmasa null qaytaradi", () => {
    const xml = "<EventNotificationAlert><eventType>videoloss</eventType></EventNotificationAlert>";
    const result = parseHikvisionPayload("application/xml", Buffer.from(xml));
    expect(result).toBeNull();
  });
});
