import http from "http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { paymentWebhookRateLimit } from "@/middleware/webhookRateLimit";

let server: http.Server;

function buildServer(): http.Server {
  const app = express();
  app.post("/webhook", paymentWebhookRateLimit, (req, res) => {
    res.status(200).json({ ok: true });
  });
  server = http.createServer(app);
  return server;
}

afterEach(() => {
  server?.close();
});

describe("paymentWebhookRateLimit", () => {
  it("chegara ichida (100 tagacha) barcha so'rovlar muvaffaqiyatli o'tadi", async () => {
    const app = buildServer();

    for (let i = 0; i < 100; i++) {
      const res = await request(app).post("/webhook");
      expect(res.status).toBe(200);
    }
  });

  it("bir daqiqada 100 tadan oshgan so'rov 429 bilan bloklanadi", async () => {
    const app = buildServer();

    for (let i = 0; i < 100; i++) {
      await request(app).post("/webhook");
    }

    const blocked = await request(app).post("/webhook");
    expect(blocked.status).toBe(429);
  });
});
