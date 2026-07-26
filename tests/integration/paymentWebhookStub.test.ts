import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import paymentRouter from "@/modules/payment/payment.routes";

function buildApp() {
  const app = express();
  app.use("/api/payments", paymentRouter);
  return app;
}

describe("POST /api/payments/payme/webhook", () => {
  it("so'rovni qabul qiladi, logga yozadi va 200 qaytaradi", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await request(buildApp())
      .post("/api/payments/payme/webhook")
      .set("Content-Type", "application/json")
      .send({ method: "CheckPerformTransaction", params: { amount: 10000 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

describe("POST /api/payments/click/webhook", () => {
  it("so'rovni qabul qiladi, logga yozadi va 200 qaytaradi", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await request(buildApp())
      .post("/api/payments/click/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("click_trans_id=123&amount=10000");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
  });
});
