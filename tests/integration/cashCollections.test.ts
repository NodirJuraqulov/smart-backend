import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import cashCollectionsRouter from "@/modules/cashCollections/cashCollections.routes";
import { getPermissionsMap } from "@/modules/operatorPermissions/operatorPermissions.service";
import { getOrganizationStats } from "@/modules/organizations/organizations.service";
import { createOperator } from "@/modules/users/users.service";
import * as reportsService from "@/modules/reports/reports.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestActiveSession,
  createTestOrganization,
  createTestTariff,
  createTestUser,
} from "./helpers";

interface CollectionRow {
  id: number;
  org_id: number;
  collected_by: number | null;
  expected_amount: string;
  collected_amount: string;
  online_amount_snapshot: string;
  note: string | null;
  period_start: Date;
  period_end: Date;
}

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let kassir: AuthTokenPayload;
let operator: AuthTokenPayload;
let kassirId: number;

const app = express();
app.use(express.json());
app.use("/api/organizations", cashCollectionsRouter);
app.use(errorHandler);

const testDb: typeof db = db;
const testRequest: typeof request = request;

function auth(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function addPayment(input: {
  org: number;
  amount: number;
  method: "cash" | "online";
  operatorId?: number | null;
  paidAt?: Date;
}): Promise<number> {
  const sessionId = await createTestActiveSession(
    input.org,
    `P${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  );
  const [id] = await testDb("tb_payments").insert({
    org_id: input.org,
    session_id: sessionId,
    amount: input.amount,
    payment_method: input.method,
    operator_id: input.operatorId ?? null,
    paid_at: input.paidAt ?? new Date(),
  });
  return id;
}

async function pendingSummary(actor: AuthTokenPayload, targetOrgId = orgId) {
  return testRequest(app)
    .get(`/api/organizations/${targetOrgId}/cash-collections/pending-summary`)
    .set("Authorization", auth(actor));
}

async function collect(actor: AuthTokenPayload, body: Record<string, unknown>, targetOrgId = orgId) {
  return testRequest(app)
    .post(`/api/organizations/${targetOrgId}/cash-collections`)
    .set("Authorization", auth(actor))
    .send(body);
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  await createTestTariff(orgId);
  await createTestTariff(otherOrgId);

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };

  const operatorUser = await createTestUser(orgId, { role: "operator" });
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };

  const created = await createOperator({
    org_id: orgId,
    name: "Kassir Test",
    login: `kassir_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    password: "kassir-password-123",
    role: "kassir",
  });
  kassirId = created.id;
  kassir = { id: created.id, org_id: orgId, role: "kassir" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("kassir roli va inkassatsiya", () => {
  it("1. kassir yaratiladi va default ruxsatlarda faqat reports true bo'ladi", async () => {
    const row = await testDb("tb_users").where({ id: kassirId }).first();
    expect(row).toMatchObject({ role: "kassir", org_id: orgId, is_active: 1 });

    const permissions = await getPermissionsMap(orgId, "kassir");
    expect(permissions.reports).toBe(true);
    const others = Object.entries(permissions).filter(([key]) => key !== "reports");
    expect(others.every(([, value]) => value === false)).toBe(true);
  });

  it("2. pending-summary naqd va onlayn yig'indini alohida hisoblaydi", async () => {
    await addPayment({ org: orgId, amount: 10000, method: "cash" });
    await addPayment({ org: orgId, amount: 5000, method: "cash" });
    await addPayment({ org: orgId, amount: 7000, method: "online" });
    await addPayment({ org: otherOrgId, amount: 99000, method: "cash" });

    const response = await pendingSummary(kassir);
    expect(response.status).toBe(200);
    expect(response.body.expected_cash_amount).toBe(15000);
    expect(response.body.online_amount).toBe(7000);
  });

  it("3. birinchi inkassatsiyada period_start organization yaratilgan vaqtdan boshlanadi", async () => {
    await addPayment({ org: orgId, amount: 12000, method: "cash" });
    const organization = await testDb("tb_organizations").where({ id: orgId }).first();

    const summary = await pendingSummary(owner);
    expect(summary.status).toBe(200);
    expect(new Date(summary.body.period_start).getTime()).toBe(
      new Date(organization.created_at).getTime()
    );
    expect(summary.body.expected_cash_amount).toBe(12000);
  });

  it("4. POST cash-collections to'g'ri snapshot bilan yozuv yaratadi", async () => {
    await addPayment({ org: orgId, amount: 20000, method: "cash" });
    await addPayment({ org: orgId, amount: 8000, method: "online" });

    const response = await collect(kassir, { collected_amount: 19500, note: "  500 kam chiqdi  " });
    expect(response.status).toBe(201);

    const saved = await testDb<CollectionRow>("tb_cash_collections").where({ org_id: orgId }).first();
    expect(saved).toBeTruthy();
    expect(Number(saved!.expected_amount)).toBe(20000);
    expect(Number(saved!.collected_amount)).toBe(19500);
    expect(Number(saved!.online_amount_snapshot)).toBe(8000);
    expect(saved!.note).toBe("500 kam chiqdi");
    expect(saved!.collected_by).toBe(kassirId);
    expect(new Date(saved!.period_end).getTime()).toBeGreaterThan(
      new Date(saved!.period_start).getTime()
    );

    const history = await testRequest(app)
      .get(`/api/organizations/${orgId}/cash-collections`)
      .set("Authorization", auth(owner));
    expect(history.status).toBe(200);
    expect(history.body.collections).toHaveLength(1);
    expect(history.body.pagination).toMatchObject({ page: 1, total: 1, total_pages: 1 });
  });

  it("5. inkassatsiyadan keyin joriy ko'rsatkich nolga tushadi", async () => {
    await addPayment({ org: orgId, amount: 30000, method: "cash" });
    await addPayment({ org: orgId, amount: 4000, method: "online" });

    const before = await getOrganizationStats(orgId);
    expect(before.today_revenue).toBe(34000);

    const created = await collect(owner, { collected_amount: 30000 });
    expect(created.status).toBe(201);

    const after = await pendingSummary(owner);
    expect(after.body.expected_cash_amount).toBe(0);
    expect(after.body.online_amount).toBe(0);

    const stats = await getOrganizationStats(orgId);
    expect(stats.today_revenue).toBe(0);

    await addPayment({ org: orgId, amount: 6000, method: "cash" });
    const next = await pendingSummary(owner);
    expect(next.body.expected_cash_amount).toBe(6000);
    expect(new Date(next.body.period_start).getTime()).toBe(
      new Date(created.body.collection.period_end).getTime()
    );
  });

  it("6. inkassatsiya kunlik va oylik hisobotlarni o'zgartirmaydi", async () => {
    await addPayment({ org: orgId, amount: 25000, method: "cash" });
    await addPayment({ org: orgId, amount: 5000, method: "online" });

    const dailyBefore = await reportsService.getDailyReport(owner, orgId, undefined);
    const now = DateTime.now().setZone("Asia/Tashkent");
    const monthlyBefore = await reportsService.getMonthlyReport(owner, orgId, now.year, now.month);

    await collect(owner, { collected_amount: 25000 });

    const dailyAfter = await reportsService.getDailyReport(owner, orgId, undefined);
    const monthlyAfter = await reportsService.getMonthlyReport(owner, orgId, now.year, now.month);

    expect(dailyAfter.cash_revenue).toBe(25000);
    expect(dailyAfter.online_revenue).toBe(5000);
    expect(dailyAfter.total_revenue).toBe(dailyBefore.total_revenue);
    expect(monthlyAfter.total_revenue).toBe(monthlyBefore.total_revenue);
  });

  it("7. operator_id filtri faqat shu operator to'lovlarini hisoblaydi", async () => {
    const otherOperator = await createTestUser(orgId, { role: "operator" });
    await addPayment({ org: orgId, amount: 11000, method: "cash", operatorId: operator.id });
    await addPayment({ org: orgId, amount: 22000, method: "cash", operatorId: otherOperator.id });
    await addPayment({ org: orgId, amount: 3000, method: "online", operatorId: operator.id });

    const all = await reportsService.getDailyReport(owner, orgId, undefined);
    expect(all.total_revenue).toBe(36000);

    const filtered = await reportsService.getDailyReport(owner, orgId, undefined, operator.id);
    expect(filtered.cash_revenue).toBe(11000);
    expect(filtered.online_revenue).toBe(3000);
    expect(filtered.total_revenue).toBe(14000);

    const otherFiltered = await reportsService.getDailyReport(owner, orgId, undefined, otherOperator.id);
    expect(otherFiltered.total_revenue).toBe(22000);
  });

  it("8. boshqa organization inkassatsiyasiga kirish 404 qaytaradi", async () => {
    await addPayment({ org: otherOrgId, amount: 50000, method: "cash" });

    const summary = await pendingSummary(kassir, otherOrgId);
    expect(summary.status).toBe(404);

    const created = await collect(kassir, { collected_amount: 100 }, otherOrgId);
    expect(created.status).toBe(404);

    const list = await testRequest(app)
      .get(`/api/organizations/${otherOrgId}/cash-collections`)
      .set("Authorization", auth(owner));
    expect(list.status).toBe(404);
    expect(await testDb("tb_cash_collections").where({ org_id: otherOrgId })).toHaveLength(0);
  });

  it("9. oddiy operator inkassatsiya endpointlariga kira olmaydi (403)", async () => {
    const summary = await pendingSummary(operator);
    expect(summary.status).toBe(403);

    const created = await collect(operator, { collected_amount: 1000 });
    expect(created.status).toBe(403);

    const list = await testRequest(app)
      .get(`/api/organizations/${orgId}/cash-collections`)
      .set("Authorization", auth(operator));
    expect(list.status).toBe(403);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });

  it("10. ro'yxatda collected_by_name to'g'ri qaytadi", async () => {
    await addPayment({ org: orgId, amount: 9000, method: "cash" });
    expect((await collect(kassir, { collected_amount: 9000 })).status).toBe(201);

    const response = await testRequest(app)
      .get(`/api/organizations/${orgId}/cash-collections`)
      .set("Authorization", auth(owner));
    expect(response.status).toBe(200);
    expect(response.body.collections).toHaveLength(1);
    expect(response.body.collections[0]).toMatchObject({
      collected_by: kassirId,
      collected_by_name: "Kassir Test",
    });
  });

  it("11. foydalanuvchi o'chirilgan bo'lsa collected_by_name null qaytadi", async () => {
    await addPayment({ org: orgId, amount: 4000, method: "cash" });
    expect((await collect(kassir, { collected_amount: 4000 })).status).toBe(201);

    await testDb("tb_users").where({ id: kassirId }).del();

    const response = await testRequest(app)
      .get(`/api/organizations/${orgId}/cash-collections`)
      .set("Authorization", auth(owner));
    expect(response.status).toBe(200);
    expect(response.body.collections).toHaveLength(1);
    expect(response.body.collections[0].collected_by).toBeNull();
    expect(response.body.collections[0].collected_by_name).toBeNull();
    expect(Number(response.body.collections[0].collected_amount)).toBe(4000);
  });

  it("collected_amount noto'g'ri bo'lsa 400 qaytaradi", async () => {
    expect((await collect(owner, {})).status).toBe(400);
    expect((await collect(owner, { collected_amount: -5 })).status).toBe(400);
    expect((await collect(owner, { collected_amount: "abc" })).status).toBe(400);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });
});
