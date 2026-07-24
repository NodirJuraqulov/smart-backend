import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPermission } from "@/middleware/auth.middleware";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { createOrganization } from "@/modules/organizations/organizations.service";
import {
  getPermissionsMap,
  hasPermission,
  listPermissions,
  updatePermissions,
} from "@/modules/operatorPermissions/operatorPermissions.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
  seedTestOperatorPermissions,
} from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await seedTestOperatorPermissions(orgId);
  const user = await createTestUser(orgId, { role: "operator" });
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

function buildApp(actor: AuthTokenPayload, sectionKey: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = actor;
    next();
  });
  app.get("/section", checkPermission(sectionKey), (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("Yangi org yaratilganda avtomatik permissions", () => {
  it("barcha section uchun can_view=true yozuvlar avtomatik yaratiladi", async () => {
    const result = await createOrganization({
      name: `Perm Test Org ${Date.now()}`,
      owner: {
        name: "Test Owner",
        login: `perm_owner_${Date.now()}`,
        password: "parol12345",
      },
      operator: {
        name: "Test Operator",
        login: `perm_op_${Date.now()}`,
        password: "parol12345",
      },
      tariff: { price_per_hour: 5000 },
    });

    const newOrgId = result.organization!.id;
    try {
      const permissions = await listPermissions(newOrgId);
      expect(permissions).toHaveLength(7);
      expect(permissions.every((p) => p.can_view)).toBe(true);
    } finally {
      await cleanupOrganization(newOrgId);
    }
  });
});

describe("checkPermission middleware", () => {
  it("can_view=false qilingan bo'limga operator so'rov yuborsa — 403", async () => {
    await updatePermissions(orgId, [{ section_key: "reports", can_view: false }]);

    const app = buildApp(operator, "reports");
    const res = await request(app).get("/section");
    expect(res.status).toBe(403);
  });

  it("can_view=true bo'limga operator so'rov yuborsa — muvaffaqiyatli o'tadi", async () => {
    const app = buildApp(operator, "reports");
    const res = await request(app).get("/section");
    expect(res.status).toBe(200);
  });

  it("super_admin har qanday holatda cheklanmaydi", async () => {
    await updatePermissions(orgId, [{ section_key: "reports", can_view: false }]);

    const superAdmin: AuthTokenPayload = { id: 1, org_id: null, role: "super_admin" };
    const app = buildApp(superAdmin, "reports");
    const res = await request(app).get("/section");
    expect(res.status).toBe(200);
  });
});

describe("hasPermission", () => {
  it("mavjud bo'lmagan yozuv uchun fail-open — true qaytaradi", async () => {
    const allowed = await hasPermission(orgId, "nonexistent_key");
    expect(allowed).toBe(true);
  });
});

describe("getPermissionsMap", () => {
  it("operator uchun to'g'ri xaritani qaytaradi", async () => {
    await updatePermissions(orgId, [{ section_key: "settings", can_view: false }]);

    const map = await getPermissionsMap(orgId, "operator");
    expect(map.settings).toBe(false);
    expect(map.reports).toBe(true);
  });

  it("super_admin uchun barchasi true", async () => {
    await updatePermissions(orgId, [{ section_key: "settings", can_view: false }]);

    const map = await getPermissionsMap(orgId, "super_admin");
    expect(Object.values(map).every((value) => value === true)).toBe(true);
  });
});

describe("updatePermissions", () => {
  it("bir nechta bo'limni bir vaqtda yangilaydi", async () => {
    const updated = await updatePermissions(orgId, [
      { section_key: "tariffs", can_view: false },
      { section_key: "subscriptions", can_view: false },
    ]);

    const tariffs = updated.find((p) => p.section_key === "tariffs");
    const subscriptions = updated.find((p) => p.section_key === "subscriptions");
    expect(tariffs?.can_view).toBe(false);
    expect(subscriptions?.can_view).toBe(false);
  });

  it("noto'g'ri section_key uchun 400 xato", async () => {
    await expect(
      updatePermissions(orgId, [{ section_key: "invalid_section", can_view: true }])
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
