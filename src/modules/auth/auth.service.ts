import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "@/config/db";
import { env } from "@/config/env";

export type UserRole = "super_admin" | "operator" | "owner";

interface UserRecord {
  id: number;
  org_id: number | null;
  name: string;
  login: string;
  password: string;
  role: UserRole;
  is_active: boolean;
}

interface UserWithOrgRecord extends UserRecord {
  org_name: string | null;
  pricing_mode: "hourly" | "interval" | null;
}

interface RefreshTokenRecord {
  id: number;
  user_id: number;
  token: string;
  expires_at: Date;
  created_at: Date;
  revoked: boolean;
}

export interface AuthTokenPayload {
  id: number;
  org_id: number | null;
  role: UserRole;
}

export class AuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.statusCode = statusCode;
  }
}

function toPublicUser(user: UserWithOrgRecord) {
  return {
    id: user.id,
    org_id: user.org_id,
    org_name: user.org_name,
    name: user.name,
    login: user.login,
    role: user.role,
    pricing_mode: user.pricing_mode,
  };
}

function userWithOrgQuery() {
  return db<UserWithOrgRecord>("tb_users")
    .leftJoin("tb_organizations", "tb_users.org_id", "tb_organizations.id")
    .select(
      "tb_users.id",
      "tb_users.org_id",
      "tb_users.name",
      "tb_users.login",
      "tb_users.password",
      "tb_users.role",
      "tb_users.is_active",
      "tb_organizations.name as org_name",
      "tb_organizations.pricing_mode as pricing_mode"
    );
}

export function signAccessToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn as jwt.SignOptions["expiresIn"],
  });
}

async function createRefreshToken(userId: number): Promise<string> {
  const token = randomBytes(40).toString("hex");
  const expiresAt = new Date(Date.now() + env.refreshToken.expiresDays * 24 * 60 * 60 * 1000);

  await db("tb_refresh_tokens").insert({
    user_id: userId,
    token,
    expires_at: expiresAt,
    revoked: false,
  });

  return token;
}

export async function login(loginName: string, password: string) {
  const user = await userWithOrgQuery().where({ "tb_users.login": loginName }).first();

  if (!user || !user.is_active) {
    throw new AuthError("Login yoki parol noto'g'ri");
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    throw new AuthError("Login yoki parol noto'g'ri");
  }

  const payload: AuthTokenPayload = { id: user.id, org_id: user.org_id, role: user.role };
  const token = signAccessToken(payload);
  const refreshToken = await createRefreshToken(user.id);

  return { token, refreshToken, user: toPublicUser(user) };
}

export async function refreshAccessToken(refreshToken: string | undefined): Promise<string> {
  if (!refreshToken) {
    throw new AuthError("Refresh token yaroqsiz");
  }

  const record = await db<RefreshTokenRecord>("tb_refresh_tokens")
    .where({ token: refreshToken })
    .first();

  if (!record || record.revoked || new Date(record.expires_at).getTime() < Date.now()) {
    throw new AuthError("Refresh token yaroqsiz");
  }

  const user = await db<UserRecord>("tb_users").where({ id: record.user_id }).first();
  if (!user || !user.is_active) {
    throw new AuthError("Refresh token yaroqsiz");
  }

  if (user.org_id) {
    const organization = await db("tb_organizations").where({ id: user.org_id }).first();
    if (!organization || !organization.is_active) {
      throw new AuthError("Refresh token yaroqsiz");
    }
  }

  const payload: AuthTokenPayload = { id: user.id, org_id: user.org_id, role: user.role };
  return signAccessToken(payload);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) {
    return;
  }
  await db("tb_refresh_tokens").where({ token: refreshToken }).update({ revoked: true });
}

export async function getUserById(id: number) {
  const user = await userWithOrgQuery().where({ "tb_users.id": id }).first();
  if (!user || !user.is_active) {
    return null;
  }
  return toPublicUser(user);
}
