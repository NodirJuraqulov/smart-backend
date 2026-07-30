import { Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { logWebhookDebug } from "@/modules/webhook/webhookDebugLog.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

function buildFakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: { "content-type": "application/json" },
    query: {},
    body: Buffer.from(JSON.stringify({ hello: "world" })),
    ...overrides,
  } as unknown as Request;
}

let orgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

afterEach(async () => {
  if (orgId) {
    await cleanupOrganization(orgId);
  }
});

afterAll(async () => {
  await closeDb();
});

describe("logWebhookDebug", () => {
  it("to'g'ri org_id bilan haqiqatan DB'ga yozadi", async () => {
    orgId = await createTestOrganization();
    const req = buildFakeRequest();

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    expect(log).toBeTruthy();
    expect(log.headers).toBeTruthy();
    expect(log.body).toBeTruthy();
  });

  it("mavjud bo'lmagan org_id bilan xato TASHLAYDI, jim yutmaydi", async () => {
    const nonExistentOrgId = 999_999_999;
    const req = buildFakeRequest();

    await expect(logWebhookDebug(nonExistentOrgId, "entry", req)).rejects.toThrow();
  });

  it("juda katta text/plain body xom holda saqlanmaydi, faqat xavfsiz metadata", async () => {
    orgId = await createTestOrganization();
    const hugeBody = Buffer.from("a".repeat(600_000));
    const req = buildFakeRequest({ body: hugeBody, headers: { "content-type": "text/plain" } });

    await logWebhookDebug(orgId, "exit", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "exit" });
    expect(log).toBeTruthy();
    const stored = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThan(64 * 1024);
    expect(JSON.stringify(stored)).not.toContain("a".repeat(1000));
    expect(stored.body).toMatchObject({ unsupportedContentType: "text/plain", byteLength: 600_000 });
  });

  it("faqat whitelist headerlar saqlanadi, Authorization/Cookie hech qachon", async () => {
    orgId = await createTestOrganization();
    const req = buildFakeRequest({
      headers: {
        "content-type": "application/json",
        authorization: "Bearer super-secret-token",
        cookie: "session=abc123",
        "x-camera-password": "hunter2",
        "user-agent": "Dahua-Camera/1.0",
      },
    });

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    const storedHeaders = typeof log.headers === "string" ? JSON.parse(log.headers) : log.headers;
    expect(storedHeaders).toEqual({ "content-type": "application/json", "user-agent": "Dahua-Camera/1.0" });
    expect(JSON.stringify(storedHeaders)).not.toContain("super-secret-token");
    expect(JSON.stringify(storedHeaders)).not.toContain("abc123");
    expect(JSON.stringify(storedHeaders)).not.toContain("hunter2");
  });

  it("Content maydonlari rekursiv ravishda redakt qilinadi, base64 saqlanmaydi", async () => {
    orgId = await createTestOrganization();
    const base64Image = Buffer.from("fake-jpeg-bytes-not-real").toString("base64");
    const payload = {
      NormalPic: { Content: base64Image, PicName: "../../../etc/passwd" },
      Nested: { Deep: { PlatePic: { Content: base64Image } } },
      Plate: { PlateNumber: "10R726ZA", BoundingBox: { Left: 1, Top: 2, Right: 3, Bottom: 4 } },
      SnapInfo: { DeviceID: "dev-1" },
      apiKey: "sk-live-abcdef",
      webhookToken: "should-not-appear",
    };
    const req = buildFakeRequest({
      body: Buffer.from(JSON.stringify(payload)),
      headers: { "content-type": "application/json" },
    });

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    const stored = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain(base64Image);
    expect(serialized).not.toContain("sk-live-abcdef");
    expect(serialized).not.toContain("should-not-appear");
    expect(serialized).not.toContain("..");
    expect(stored.body.NormalPic.Content).toMatchObject({ redacted: true, originalLength: base64Image.length });
    expect(stored.body.Nested.Deep.PlatePic.Content).toMatchObject({ redacted: true });
    expect(stored.body.NormalPic.PicName).toBe("passwd");
    expect(stored.body.NormalPic.PicName).not.toContain("..");
    expect(stored.body.Plate.PlateNumber).toBe("10R726ZA");
    expect(stored.body.Plate.BoundingBox).toEqual({ Left: 1, Top: 2, Right: 3, Bottom: 4 });
    expect(stored.body.SnapInfo.DeviceID).toBe("dev-1");
    expect(stored.body.apiKey).toEqual({ redacted: true });
    expect(stored.body.webhookToken).toEqual({ redacted: true });
  });

  it("sezgir query qiymatlari (token/key/secret) redakt qilinadi", async () => {
    orgId = await createTestOrganization();
    const req = buildFakeRequest({
      query: { token: "leak-me", access_key: "leak-me-too", direction: "entry" },
    });

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    const stored = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    expect(stored.query.token).toEqual({ redacted: true });
    expect(stored.query.access_key).toEqual({ redacted: true });
    expect(stored.query.direction).toBe("entry");
  });

  it("multipart so'rovda xom baytlar yoki base64 saqlanmaydi", async () => {
    orgId = await createTestOrganization();
    const req = buildFakeRequest({
      body: Buffer.from("--boundary\r\nContent-Disposition: form-data\r\n\r\nbinary-ish-data\r\n--boundary--"),
      headers: { "content-type": "multipart/form-data; boundary=boundary" },
    });

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    const stored = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    expect(stored.body).toMatchObject({ multipart: true });
    expect(JSON.stringify(stored)).not.toContain("binary-ish-data");
    expect(JSON.stringify(stored)).not.toContain("base64");
  });

  it("sanitizatsiyadan keyin ham 64KB limitdan oshsa, xavfsiz truncation qo'llanadi", async () => {
    orgId = await createTestOrganization();
    const payload: Record<string, string> = {};
    for (let i = 0; i < 5000; i += 1) {
      payload[`field_${i}`] = "x".repeat(50);
    }
    const req = buildFakeRequest({
      body: Buffer.from(JSON.stringify(payload)),
      headers: { "content-type": "application/json" },
    });

    await logWebhookDebug(orgId, "entry", req);

    const [log] = await db("tb_webhook_debug_logs").where({ org_id: orgId, direction: "entry" });
    const stored = typeof log.body === "string" ? JSON.parse(log.body) : log.body;
    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThan(64 * 1024);
    expect(Array.isArray(stored.topLevelKeys)).toBe(true);
  });
});
