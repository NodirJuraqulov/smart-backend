import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/auth/auth.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/auth.service")>();
  return {
    ...actual,
    login: vi.fn().mockRejectedValue(new actual.AuthError("Login yoki parol noto'g'ri")),
  };
});

import { loginIpRateLimit, loginUsernameRateLimit } from "@/middleware/loginRateLimit";
import { loginHandler } from "@/modules/auth/auth.controller";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/login", loginIpRateLimit, loginUsernameRateLimit, async (req, res, next) => {
    try {
      await loginHandler(req, res);
    } catch (err) {
      next(err);
    }
  });
  return app;
}

describe("login rate limiting", () => {
  it("5 marta muvaffaqiyatsiz urinish 401 qaytaradi, 6-chisi 429 bilan bloklanadi", async () => {
    const app = buildApp();

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await request(app).post("/login").send({ login: "rl_user", password: "wrong" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post("/login").send({ login: "rl_user", password: "wrong" });
    expect(blocked.status).toBe(429);
  });
});
