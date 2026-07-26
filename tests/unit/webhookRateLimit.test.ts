import http from "http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { webhookRateLimit } from "@/middleware/webhookRateLimit";

let server: http.Server;

function buildServer(): http.Server {
  const app = express();
  app.post("/webhook/:token/:direction", webhookRateLimit, (req, res) => {
    res.status(200).json({ ok: true });
  });
  server = http.createServer(app);
  return server;
}

afterEach(() => {
  server?.close();
});

describe("webhookRateLimit", () => {
  it("chegara ichida (60 tagacha) barcha so'rovlar muvaffaqiyatli o'tadi", async () => {
    const app = buildServer();
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < 60; i++) {
      const res = await request(app).post(`/webhook/${token}/entry`);
      expect(res.status).toBe(200);
    }
  });

  it("bir daqiqada 60 tadan oshgan so'rov 429 bilan bloklanadi", async () => {
    const app = buildServer();
    const token = `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < 60; i++) {
      await request(app).post(`/webhook/${token}/entry`);
    }

    const blocked = await request(app).post(`/webhook/${token}/entry`);
    expect(blocked.status).toBe(429);
  });

  it("boshqa webhook_token uchun chegara mustaqil hisoblanadi", async () => {
    const app = buildServer();
    const exhaustedToken = `token-a-${Date.now()}`;
    const freshToken = `token-b-${Date.now()}`;

    for (let i = 0; i < 60; i++) {
      await request(app).post(`/webhook/${exhaustedToken}/entry`);
    }
    const blocked = await request(app).post(`/webhook/${exhaustedToken}/entry`);
    expect(blocked.status).toBe(429);

    const fresh = await request(app).post(`/webhook/${freshToken}/entry`);
    expect(fresh.status).toBe(200);
  });
});
