import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { env } from "@/config/env";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";

describe("signAccessToken / jwt tekshiruvi", () => {
  const payload: AuthTokenPayload = { id: 1, org_id: 3, role: "operator" };

  it("token yaratadi va to'g'ri sirr bilan tekshirilganda asl payload qaytadi", () => {
    const token = signAccessToken(payload);
    const decoded = jwt.verify(token, env.jwt.secret) as AuthTokenPayload;

    expect(decoded.id).toBe(payload.id);
    expect(decoded.org_id).toBe(payload.org_id);
    expect(decoded.role).toBe(payload.role);
  });

  it("noto'g'ri sirr bilan tekshirilsa xato tashlanadi", () => {
    const token = signAccessToken(payload);
    expect(() => jwt.verify(token, "boshqa_notogri_sirr")).toThrow();
  });

  it("buzilgan (o'zgartirilgan) token uchun xato tashlanadi", () => {
    const token = signAccessToken(payload);
    const tampered = `${token}tampered`;
    expect(() => jwt.verify(tampered, env.jwt.secret)).toThrow();
  });

  it("muddati tugagan token uchun xato tashlanadi", () => {
    const expiredToken = jwt.sign(payload, env.jwt.secret, { expiresIn: -10 });
    expect(() => jwt.verify(expiredToken, env.jwt.secret)).toThrow(jwt.TokenExpiredError);
  });
});
