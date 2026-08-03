import http from "http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhookRateLimit } from "@/middleware/webhookRateLimit";

const TEST_LIMIT = 5;

let server: http.Server;

beforeAll(() => {
  const app = express();
  app.set("trust proxy", "loopback");
  app.post("/webhook/:token/:direction", createWebhookRateLimit(TEST_LIMIT), (req, res) => {
    res.status(200).json({ ok: true });
  });
  server = http.createServer(app);
});

afterAll(() => {
  server?.close();
});

describe("webhookRateLimit", () => {
  it("chegara ichida barcha so'rovlar muvaffaqiyatli o'tadi", async () => {
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < TEST_LIMIT; i++) {
      const res = await request(server)
        .post(`/webhook/${token}/entry`)
        .set("X-Forwarded-For", "198.51.100.10");
      expect(res.status).toBe(200);
    }
  });

  it("chegaradan oshgan so'rov 429 bilan bloklanadi", async () => {
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < TEST_LIMIT; i++) {
      await request(server)
        .post(`/webhook/${token}/entry`)
        .set("X-Forwarded-For", "198.51.100.20");
    }

    const blocked = await request(server)
      .post(`/webhook/${token}/entry`)
      .set("X-Forwarded-For", "198.51.100.20");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      message: "Webhook so'rovlari limiti oshdi. Bir daqiqadan keyin qayta urining.",
    });
  });

  it("limit token emas IP bo'yicha umumiy hisoblanadi", async () => {
    const exhaustedToken = `token-a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const freshToken = `token-b-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < TEST_LIMIT; i++) {
      await request(server)
        .post(`/webhook/${exhaustedToken}/entry`)
        .set("X-Forwarded-For", "198.51.100.30");
    }
    const blocked = await request(server)
      .post(`/webhook/${freshToken}/entry`)
      .set("X-Forwarded-For", "198.51.100.30");
    expect(blocked.status).toBe(429);

    const fresh = await request(server)
      .post(`/webhook/${freshToken}/entry`)
      .set("X-Forwarded-For", "198.51.100.31");
    expect(fresh.status).toBe(200);
  });
});
