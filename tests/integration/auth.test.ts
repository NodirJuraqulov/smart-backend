import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { env } from "@/config/env";
import {
  AuthError,
  AuthTokenPayload,
  getUserById,
  login,
  logout,
  refreshAccessToken,
} from "@/modules/auth/auth.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
  setOrgPricingMode,
} from "./helpers";

let orgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("login", () => {
  it("to'g'ri parol bilan muvaffaqiyatli login qiladi", async () => {
    const { login: loginName, password } = await createTestUser(orgId);

    const result = await login(loginName, password);

    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.user.login).toBe(loginName);
    expect(result.user.org_id).toBe(orgId);
  });

  it("noto'g'ri parol bilan 401 (AuthError) tashlaydi", async () => {
    const { login: loginName } = await createTestUser(orgId);

    await expect(login(loginName, "notogri-parol")).rejects.toBeInstanceOf(AuthError);
    await expect(login(loginName, "notogri-parol")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("mavjud bo'lmagan login uchun 401 tashlaydi", async () => {
    await expect(login("mavjud_emas_login", "har-qanday-parol")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("bloklangan (is_active=false) foydalanuvchi uchun 401 tashlaydi", async () => {
    const { login: loginName, password } = await createTestUser(orgId, { is_active: false });

    await expect(login(loginName, password)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("user.pricing_mode org'ning joriy pricing_mode'ini qaytaradi (operator uchun)", async () => {
    await setOrgPricingMode(orgId, "interval");
    const { login: loginName, password } = await createTestUser(orgId, { role: "operator" });

    const result = await login(loginName, password);
    expect(result.user.pricing_mode).toBe("interval");

    const me = await getUserById(result.user.id);
    expect(me?.pricing_mode).toBe("interval");
  });

  it("super_admin uchun (org_id yo'q) pricing_mode null qaytaradi", async () => {
    const { login: loginName, password } = await createTestUser(null, { role: "super_admin" });

    const result = await login(loginName, password);
    expect(result.user.pricing_mode).toBeNull();
  });

  it("token yaratiladi va to'g'ri payload bilan tekshirilishi mumkin", async () => {
    const { login: loginName, password } = await createTestUser(orgId, { role: "operator" });

    const result = await login(loginName, password);
    const decoded = jwt.verify(result.token, env.jwt.secret) as AuthTokenPayload;

    expect(decoded.id).toBe(result.user.id);
    expect(decoded.org_id).toBe(orgId);
    expect(decoded.role).toBe("operator");
  });
});

describe("refreshAccessToken", () => {
  it("yaroqli refresh token bilan yangi access token qaytaradi", async () => {
    const { login: loginName, password } = await createTestUser(orgId);
    const { refreshToken } = await login(loginName, password);

    const newAccessToken = await refreshAccessToken(refreshToken);
    expect(newAccessToken).toBeTruthy();
    expect(() => jwt.verify(newAccessToken, env.jwt.secret)).not.toThrow();
  });

  it("token berilmasa AuthError tashlaydi", async () => {
    await expect(refreshAccessToken(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  it("mavjud bo'lmagan refresh token uchun AuthError tashlaydi", async () => {
    await expect(refreshAccessToken("mavjud-bolmagan-token")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("muddati tugagan refresh token uchun AuthError tashlaydi", async () => {
    const user = await createTestUser(orgId);
    const expiredToken = "expired-test-token";
    await db("tb_refresh_tokens").insert({
      user_id: user.id,
      token: expiredToken,
      expires_at: new Date(Date.now() - 1000),
      revoked: false,
    });

    await expect(refreshAccessToken(expiredToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("bekor qilingan (revoked) refresh token uchun AuthError tashlaydi", async () => {
    const { login: loginName, password } = await createTestUser(orgId);
    const { refreshToken } = await login(loginName, password);

    await logout(refreshToken);

    await expect(refreshAccessToken(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });
});
