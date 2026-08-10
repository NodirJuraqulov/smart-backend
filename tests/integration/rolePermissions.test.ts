import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import organizationsRouter from "@/modules/organizations/organizations.routes";
import exitCandidatesRouter from "@/modules/exitCandidates/exitCandidates.routes";
import { createOrganization } from "@/modules/organizations/organizations.service";
import {
  getPermissionsMap,
  seedDefaultPermissions,
} from "@/modules/operatorPermissions/operatorPermissions.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

interface PermissionEntry {
  section_key: string;
  can_view: boolean;
}

let orgId: number;
let otherOrgId: number;
let superAdmin: AuthTokenPayload;
let kassir: AuthTokenPayload;

const app = express();
app.use(express.json());
app.use("/api/admin/organizations", organizationsRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;

function auth(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function permissionsUrl(targetOrgId: number, role?: string): string {
  const base = `/api/admin/organizations/${targetOrgId}/permissions`;
  return role === undefined ? base : `${base}?role=${role}`;
}

async function getPermissions(targetOrgId: number, role?: string) {
  return testRequest(app).get(permissionsUrl(targetOrgId, role)).set("Authorization", auth(superAdmin));
}

async function patchPermissions(
  targetOrgId: number,
  body: Record<string, unknown>,
  actor: AuthTokenPayload = superAdmin
) {
  return testRequest(app)
    .patch(permissionsUrl(targetOrgId))
    .set("Authorization", auth(actor))
    .send(body);
}

function asMap(permissions: PermissionEntry[]): Record<string, boolean> {
  return Object.fromEntries(permissions.map((entry) => [entry.section_key, entry.can_view]));
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  await createTestTariff(orgId);
  await createTestTariff(otherOrgId);
  await seedDefaultPermissions(testDb, orgId);
  await seedDefaultPermissions(testDb, otherOrgId);

  const admin = await createTestUser(null, { role: "super_admin" });
  superAdmin = { id: admin.id, org_id: null, role: "super_admin" };

  const kassirUser = await createTestUser(orgId, { role: "kassir" });
  kassir = { id: kassirUser.id, org_id: orgId, role: "kassir" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await testDb("tb_users").whereNull("org_id").del();
});

afterAll(closeDb);

describe("rol bo'yicha boshqariladigan ruxsatlar", () => {
  it("1. yangi stoyankada operator to'liq, kassir esa faqat reports ruxsatini oladi", async () => {
    const created = await createOrganization({
      name: `Perm Org ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      owner: { name: "Ega", login: `owner_${Date.now()}`, password: "owner-password-123" },
      tariff: { price_per_hour: 5000 },
    });
    const newOrgId = created.organization!.id;

    const rows = await testDb("tb_operator_permissions").where({ org_id: newOrgId });
    expect(rows).toHaveLength(14);

    const operatorMap = asMap(await getOperatorRows(newOrgId));
    const kassirMap = asMap(await getKassirRows(newOrgId));
    expect(Object.values(operatorMap).every(Boolean)).toBe(true);
    expect(kassirMap.reports).toBe(true);
    expect(Object.entries(kassirMap).filter(([key]) => key !== "reports").every(([, v]) => v === false)).toBe(
      true
    );

    await cleanupOrganization(newOrgId);
  });

  it("1b. role ko'rsatilmagan yozuv operator sifatida saqlanadi (migratsiya default'i)", async () => {
    const bareOrgId = await createTestOrganization();
    const [legacyId] = await testDb("tb_operator_permissions").insert({
      org_id: bareOrgId,
      section_key: "dashboard",
      can_view: true,
    });

    const legacyRow = await testDb("tb_operator_permissions").where({ id: legacyId }).first();
    expect(legacyRow.role).toBe("operator");

    await cleanupOrganization(bareOrgId);
  });

  async function getOperatorRows(targetOrgId: number): Promise<PermissionEntry[]> {
    const rows = await testDb("tb_operator_permissions")
      .where({ org_id: targetOrgId, role: "operator" })
      .select("section_key", "can_view");
    return rows.map((row) => ({ section_key: row.section_key, can_view: !!row.can_view }));
  }

  async function getKassirRows(targetOrgId: number): Promise<PermissionEntry[]> {
    const rows = await testDb("tb_operator_permissions")
      .where({ org_id: targetOrgId, role: "kassir" })
      .select("section_key", "can_view");
    return rows.map((row) => ({ section_key: row.section_key, can_view: !!row.can_view }));
  }

  it("2. GET ?role=kassir kassir ruxsatlarini qaytaradi, operatorga tegmaydi", async () => {
    const kassirResponse = await getPermissions(orgId, "kassir");
    expect(kassirResponse.status).toBe(200);
    expect(kassirResponse.body.role).toBe("kassir");
    const kassirMap = asMap(kassirResponse.body.permissions);
    expect(kassirMap).toMatchObject({ reports: true, sessions: false, settings: false });

    const operatorResponse = await getPermissions(orgId, "operator");
    expect(operatorResponse.body.role).toBe("operator");
    expect(Object.values(asMap(operatorResponse.body.permissions)).every(Boolean)).toBe(true);
  });

  it("3. PATCH role=kassir faqat kassir ruxsatlarini o'zgartiradi", async () => {
    const before = asMap((await getPermissions(orgId, "operator")).body.permissions);

    const response = await patchPermissions(orgId, {
      role: "kassir",
      permissions: [
        { section_key: "sessions", can_view: true },
        { section_key: "reports", can_view: false },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.role).toBe("kassir");

    const kassirMap = asMap(response.body.permissions);
    expect(kassirMap.sessions).toBe(true);
    expect(kassirMap.reports).toBe(false);

    const after = asMap((await getPermissions(orgId, "operator")).body.permissions);
    expect(after).toEqual(before);
    expect(Object.values(after).every(Boolean)).toBe(true);
  });

  it("4. kassir yangi ruxsat berilgandan keyin o'sha bo'limga kira oladi", async () => {
    const denied = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", auth(kassir));
    expect(denied.status).toBe(403);

    await patchPermissions(orgId, {
      role: "kassir",
      permissions: [{ section_key: "sessions", can_view: true }],
    });

    const allowed = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", auth(kassir));
    expect(allowed.status).toBe(204);

    const map = await getPermissionsMap(orgId, "kassir");
    expect(map.sessions).toBe(true);
    expect(map.settings).toBe(false);
  });

  it("5. role parametrisiz GET va PATCH eskicha operator ustida ishlaydi", async () => {
    const listed = await getPermissions(orgId);
    expect(listed.status).toBe(200);
    expect(listed.body.role).toBe("operator");
    expect(Object.values(asMap(listed.body.permissions)).every(Boolean)).toBe(true);

    const updated = await testRequest(app)
      .put(permissionsUrl(orgId))
      .set("Authorization", auth(superAdmin))
      .send({ permissions: [{ section_key: "settings", can_view: false }] });
    expect(updated.status).toBe(200);
    expect(asMap(updated.body.permissions).settings).toBe(false);

    const kassirMap = asMap((await getPermissions(orgId, "kassir")).body.permissions);
    expect(kassirMap).toMatchObject({ reports: true, settings: false });
    expect(await getPermissionsMap(orgId, "operator")).toMatchObject({ settings: false, reports: true });
  });

  it("6. bir stoyanka ruxsatlari boshqasiga ta'sir qilmaydi", async () => {
    await patchPermissions(orgId, {
      role: "kassir",
      permissions: [{ section_key: "sessions", can_view: true }],
    });

    const otherKassir = asMap((await getPermissions(otherOrgId, "kassir")).body.permissions);
    expect(otherKassir.sessions).toBe(false);
    expect(otherKassir.reports).toBe(true);

    const otherKassirUser = await createTestUser(otherOrgId, { role: "kassir" });
    const denied = await testRequest(app)
      .get("/api/exit-candidates/next")
      .set("Authorization", auth({ id: otherKassirUser.id, org_id: otherOrgId, role: "kassir" }));
    expect(denied.status).toBe(403);
  });

  it("noto'g'ri role qiymati 400 qaytaradi", async () => {
    expect((await getPermissions(orgId, "owner")).status).toBe(400);
    expect(
      (await patchPermissions(orgId, { role: "super_admin", permissions: [] })).status
    ).toBe(400);
  });
});
