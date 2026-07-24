import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPermission, isOperatorOrOwner, isOwner } from "@/middleware/auth.middleware";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { addOperator, createOrganization } from "@/modules/organizations/organizations.service";
import { updateOperator } from "@/modules/users/users.service";
import { getPermissionsMap, updatePermissions } from "@/modules/operatorPermissions/operatorPermissions.service";
import { getSessionById } from "@/modules/parking/parking.service";
import { updateTariff } from "@/modules/tariffs/tariffs.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
  seedTestOperatorPermissions,
} from "./helpers";

let orgId: number;
let owner: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  await seedTestOperatorPermissions(orgId);
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("createOrganization — owner va operator", () => {
  it("operator bilan yaratilsa — owner va operator ikkalasi ham to'g'ri yaratiladi", async () => {
    const result = await createOrganization({
      name: `Owner Org ${Date.now()}`,
      owner: { name: "Egasi", login: `owner_${Date.now()}`, password: "parol12345" },
      operator: { name: "Operator", login: `op_${Date.now()}`, password: "parol12345" },
      tariff: { price_per_hour: 5000 },
    });

    try {
      expect(result.owner?.role).toBe("owner");
      expect(result.owner?.org_id).toBe(result.organization?.id);
      expect(result.operator?.role).toBe("operator");
      expect(result.operator?.org_id).toBe(result.organization?.id);
    } finally {
      await cleanupOrganization(result.organization!.id);
    }
  });

  it("operatorsiz yaratilsa — faqat owner yaratiladi, operator yo'q", async () => {
    const result = await createOrganization({
      name: `Owner Only Org ${Date.now()}`,
      owner: { name: "Egasi", login: `owner_only_${Date.now()}`, password: "parol12345" },
      tariff: { price_per_hour: 5000 },
    });

    try {
      expect(result.owner?.role).toBe("owner");
      expect(result.operator).toBeNull();
    } finally {
      await cleanupOrganization(result.organization!.id);
    }
  });
});

describe("Owner — permission cheklovisiz kirish", () => {
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

  it("can_view=false bo'lsa ham owner cheklanmaydi", async () => {
    await updatePermissions(orgId, [{ section_key: "reports", can_view: false }]);

    const app = buildApp(owner, "reports");
    const res = await request(app).get("/section");
    expect(res.status).toBe(200);
  });

  it("isOperatorOrOwner middleware'dan o'tadi (operator kira oladigan joylarga)", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = owner;
      next();
    });
    app.get("/section", isOperatorOrOwner, (req, res) => res.json({ ok: true }));

    const res = await request(app).get("/section");
    expect(res.status).toBe(200);
  });

  it("isOwner middleware role==='owner' uchun o'tadi, operator uchun 403", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = req.headers["x-role"] === "operator" ? { id: 999, org_id: orgId, role: "operator" } : owner;
      next();
    });
    app.get("/section", isOwner, (req, res) => res.json({ ok: true }));

    const ownerRes = await request(app).get("/section");
    expect(ownerRes.status).toBe(200);

    const operatorRes = await request(app).get("/section").set("x-role", "operator");
    expect(operatorRes.status).toBe(403);
  });
});

describe("GET /auth/me — owner uchun permissions", () => {
  it("can_view=false yozuvlar bo'lsa ham owner uchun barchasi true", async () => {
    await updatePermissions(orgId, [{ section_key: "settings", can_view: false }]);

    const map = await getPermissionsMap(orgId, "owner");
    expect(Object.values(map).every((value) => value === true)).toBe(true);
  });
});

describe("Owner — scope (boshqa org'ga kira olmasligi)", () => {
  it("boshqa org'dagi sessiyani ko'rishga urinsa — 404", async () => {
    const otherOrgId = await createTestOrganization();
    try {
      const sessionId = await createTestActiveSession(otherOrgId, "01O100AA");
      await expect(getSessionById(owner, sessionId)).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });

  it("boshqa org'dagi tarifni tahrirlashga urinsa — 404", async () => {
    const otherOrgId = await createTestOrganization();
    try {
      const tariffId = await createTestTariff(otherOrgId);
      await expect(updateTariff(owner, tariffId, { price_per_hour: 1 })).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await cleanupOrganization(otherOrgId);
    }
  });
});

describe("Owner — operator kira oladigan joylarga to'liq parity", () => {
  it("owner tarifni tahrirlay oladi (operator kabi)", async () => {
    const tariffId = await createTestTariff(orgId, { price_per_hour: 5000 });
    const updated = await updateTariff(owner, tariffId, { price_per_hour: 8000 });
    expect(Number(updated?.price_per_hour)).toBe(8000);
  });
});

describe("POST /operator — keyinroq operator qo'shish", () => {
  it("operatori yo'q org'ga muvaffaqiyatli qo'shiladi", async () => {
    const operatorUser = await addOperator(orgId, {
      name: "Yangi Operator",
      login: `later_op_${Date.now()}`,
      password: "parol12345",
    });
    expect(operatorUser?.role).toBe("operator");
    expect(operatorUser?.org_id).toBe(orgId);
  });

  it("allaqachon operator bor org'ga yana qo'shishga urinish — 400", async () => {
    await addOperator(orgId, { name: "Birinchi", login: `first_op_${Date.now()}`, password: "parol12345" });

    await expect(
      addOperator(orgId, { name: "Ikkinchi", login: `second_op_${Date.now()}`, password: "parol12345" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("resetPassword (updateOperator) — owner uchun ham ishlaydi", () => {
  it("owner foydalanuvchining parolini yangilaydi", async () => {
    const updated = await updateOperator(owner.id, { password: "yangiParol123" });
    expect(updated?.role).toBe("owner");

    const row = await db("tb_users").where({ id: owner.id }).first();
    const matches = await bcrypt.compare("yangiParol123", row.password);
    expect(matches).toBe(true);
  });
});
