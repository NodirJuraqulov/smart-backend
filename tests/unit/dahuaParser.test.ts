import { describe, expect, it } from "vitest";
import { dahuaParser } from "@/modules/webhook/parsers/dahuaParser";
import { UnsupportedCameraPayloadError } from "@/modules/webhook/webhookErrors";

describe("dahuaParser (skelet)", () => {
  it("UnsupportedCameraPayloadError tashlaydi", async () => {
    await expect(
      dahuaParser.parse({
        rawBody: Buffer.from("dahua-payload"),
        headers: {},
        query: {},
        contentType: "application/json",
        direction: "entry",
        organization: { id: 1, cameraBrand: "dahua" },
      })
    ).rejects.toBeInstanceOf(UnsupportedCameraPayloadError);
  });

  it("xato kodi 'unsupported_camera_payload' bo'ladi", async () => {
    await expect(
      dahuaParser.parse({
        rawBody: Buffer.from("dahua-payload"),
        headers: {},
        query: {},
        contentType: "application/json",
        direction: "exit",
        organization: { id: 1, cameraBrand: "dahua" },
      })
    ).rejects.toMatchObject({ code: "unsupported_camera_payload" });
  });

  it("diagnostika uchun contentType va rawPayload preview saqlanadi", async () => {
    await expect(
      dahuaParser.parse({
        rawBody: Buffer.from("<xml>dahua-real-payload</xml>"),
        headers: {},
        query: {},
        contentType: "application/xml",
        direction: "entry",
        organization: { id: 1, cameraBrand: "dahua" },
      })
    ).rejects.toMatchObject({
      details: {
        contentType: "application/xml",
        rawPayloadPreview: "<xml>dahua-real-payload</xml>",
      },
    });
  });
});
