import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createGeneralApiRateLimit } from "@/middleware/generalRateLimit";

describe("general API rate limiting", () => {
  it("300 so'rovga ruxsat beradi va 301-so'rovni 429 bilan bloklaydi", async () => {
    const app = express();
    app.use("/api", createGeneralApiRateLimit());
    app.get("/api/test", (req, res) => res.json({ ok: true }));

    for (let requestNumber = 1; requestNumber <= 300; requestNumber++) {
      const response = await request(app).get("/api/test");
      expect(response.status).toBe(200);
    }

    const blocked = await request(app).get("/api/test");

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      message: "So'rovlar limiti oshdi. Bir daqiqadan keyin qayta urining.",
    });
  });
});
