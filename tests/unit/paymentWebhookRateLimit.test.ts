import http from "http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaymentWebhookRateLimit } from "@/middleware/webhookRateLimit";

const TEST_LIMIT = 5;

let server: http.Server;

beforeAll(() => {
  const app = express();
  app.post("/webhook-within-limit", createPaymentWebhookRateLimit(TEST_LIMIT), (req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post("/webhook-over-limit", createPaymentWebhookRateLimit(TEST_LIMIT), (req, res) => {
    res.status(200).json({ ok: true });
  });
  server = http.createServer(app);
});

afterAll(() => {
  server?.close();
});

describe("paymentWebhookRateLimit", () => {
  it("chegara ichida barcha so'rovlar muvaffaqiyatli o'tadi", async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      const res = await request(server).post("/webhook-within-limit");
      expect(res.status).toBe(200);
    }
  });

  it("chegaradan oshgan so'rov 429 bilan bloklanadi", async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      await request(server).post("/webhook-over-limit");
    }

    const blocked = await request(server).post("/webhook-over-limit");
    expect(blocked.status).toBe(429);
  });
});
