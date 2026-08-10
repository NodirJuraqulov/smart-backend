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
  operator_id: number | null;
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
let operatorA: AuthTokenPayload;
let operatorB: AuthTokenPayload;
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

async function pendingSummary(
  actor: AuthTokenPayload,
  operatorId: number | undefined,
  targetOrgId = orgId
) {
  const query = operatorId === undefined ? "" : `?operator_id=${operatorId}`;
  return testRequest(app)
    .get(`/api/organizations/${targetOrgId}/cash-collections/pending-summary${query}`)
    .set("Authorization", auth(actor));
}

async function collect(actor: AuthTokenPayload, body: Record<string, unknown>, targetOrgId = orgId) {
  return testRequest(app)
    .post(`/api/organizations/${targetOrgId}/cash-collections`)
    .set("Authorization", auth(actor))
    .send(body);
}

async function listCollections(actor: AuthTokenPayload, targetOrgId = orgId) {
  return testRequest(app)
    .get(`/api/organizations/${targetOrgId}/cash-collections`)
    .set("Authorization", auth(actor));
}

async function operatorsList(actor: AuthTokenPayload, targetOrgId = orgId) {
  return testRequest(app)
    .get(`/api/organizations/${targetOrgId}/operators-list`)
    .set("Authorization", auth(actor));
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  await createTestTariff(orgId);
  await createTestTariff(otherOrgId);

  const ownerUser = await createTestUser(orgId, { role: "owner" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };

  const operatorAUser = await createTestUser(orgId, { role: "operator" });
  operatorA = { id: operatorAUser.id, org_id: orgId, role: "operator" };

  const operatorBUser = await createTestUser(orgId, { role: "operator" });
  operatorB = { id: operatorBUser.id, org_id: orgId, role: "operator" };

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

describe("operator darajasidagi inkassatsiya", () => {
  it("1. pending-summary faqat tanlangan operator to'lovlarini hisoblaydi", async () => {
    await addPayment({ org: orgId, amount: 10000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 5000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 7000, method: "online", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 99000, method: "cash", operatorId: operatorB.id });

    const response = await pendingSummary(kassir, operatorA.id);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operator_id: operatorA.id,
      expected_cash_amount: 15000,
      online_amount: 7000,
    });

    const forB = await pendingSummary(kassir, operatorB.id);
    expect(forB.body.expected_cash_amount).toBe(99000);
    expect(forB.body.online_amount).toBe(0);
  });

  it("2. birinchi inkassatsiyada davr operatorning created_at'idan boshlanadi", async () => {
    await addPayment({ org: orgId, amount: 12000, method: "cash", operatorId: operatorA.id });
    const operatorRow = await testDb("tb_users").where({ id: operatorA.id }).first();

    const response = await pendingSummary(owner, operatorA.id);
    expect(response.status).toBe(200);
    expect(new Date(response.body.period_start).getTime()).toBe(
      new Date(operatorRow.created_at).getTime()
    );
    expect(response.body.expected_cash_amount).toBe(12000);
  });

  it("3. operator B inkassatsiyasi operator A hisobiga ta'sir qilmaydi", async () => {
    await addPayment({ org: orgId, amount: 20000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 30000, method: "cash", operatorId: operatorB.id });

    const firstA = await collect(kassir, { operator_id: operatorA.id, collected_amount: 20000 });
    expect(firstA.status).toBe(201);

    const afterA = await pendingSummary(kassir, operatorA.id);
    expect(afterA.body.expected_cash_amount).toBe(0);

    const bUntouched = await pendingSummary(kassir, operatorB.id);
    expect(bUntouched.body.expected_cash_amount).toBe(30000);

    await collect(kassir, { operator_id: operatorB.id, collected_amount: 30000 });

    await addPayment({ org: orgId, amount: 4000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 8000, method: "cash", operatorId: operatorB.id });

    const secondA = await pendingSummary(kassir, operatorA.id);
    expect(secondA.body.expected_cash_amount).toBe(4000);
    expect(new Date(secondA.body.period_start).getTime()).toBe(
      new Date(firstA.body.collection.period_end).getTime()
    );

    const secondB = await pendingSummary(kassir, operatorB.id);
    expect(secondB.body.expected_cash_amount).toBe(8000);
  });

  it("4. POST operator_id va snapshotlarni to'g'ri saqlaydi", async () => {
    await addPayment({ org: orgId, amount: 20000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 8000, method: "online", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 50000, method: "cash", operatorId: operatorB.id });

    const response = await collect(kassir, {
      operator_id: operatorA.id,
      collected_amount: 19500,
      note: "  500 kam chiqdi  ",
    });
    expect(response.status).toBe(201);

    const saved = await testDb<CollectionRow>("tb_cash_collections").where({ org_id: orgId }).first();
    expect(saved).toMatchObject({
      operator_id: operatorA.id,
      collected_by: kassirId,
      note: "500 kam chiqdi",
    });
    expect(Number(saved!.expected_amount)).toBe(20000);
    expect(Number(saved!.collected_amount)).toBe(19500);
    expect(Number(saved!.online_amount_snapshot)).toBe(8000);
  });

  it("5. operators-list faqat shu org'dagi operatorlarni qaytaradi", async () => {
    await createTestUser(otherOrgId, { role: "operator" });

    const response = await operatorsList(kassir);
    expect(response.status).toBe(200);

    const ids = response.body.operators.map((operator: { id: number }) => operator.id);
    expect(new Set(ids)).toEqual(new Set([operatorA.id, operatorB.id]));
    expect(ids).not.toContain(kassirId);
    expect(ids).not.toContain(owner.id);
    expect(response.body.operators[0]).toHaveProperty("name");
  });

  it("6. ro'yxatda operator_id_name va collected_by_name ko'rsatiladi", async () => {
    await addPayment({ org: orgId, amount: 9000, method: "cash", operatorId: operatorA.id });
    await collect(kassir, { operator_id: operatorA.id, collected_amount: 9000 });

    const response = await listCollections(owner);
    expect(response.status).toBe(200);
    expect(response.body.collections).toHaveLength(1);
    expect(response.body.collections[0]).toMatchObject({
      operator_id: operatorA.id,
      operator_id_name: "Test User",
      collected_by_name: "Kassir Test",
    });
  });

  it("7. operator_id berilmasa 400 qaytaradi", async () => {
    expect((await pendingSummary(kassir, undefined)).status).toBe(400);
    expect((await collect(kassir, { collected_amount: 1000 })).status).toBe(400);
    expect((await collect(kassir, { operator_id: "abc", collected_amount: 1000 })).status).toBe(400);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });

  it("8. boshqa org operatori bilan inkassatsiya qilib bo'lmaydi", async () => {
    const foreignOperator = await createTestUser(otherOrgId, { role: "operator" });

    expect((await pendingSummary(kassir, foreignOperator.id)).status).toBe(404);
    expect(
      (await collect(kassir, { operator_id: foreignOperator.id, collected_amount: 100 })).status
    ).toBe(404);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });

  it("9. kassir yaratiladi va default ruxsatlarda faqat reports true bo'ladi", async () => {
    const row = await testDb("tb_users").where({ id: kassirId }).first();
    expect(row).toMatchObject({ role: "kassir", org_id: orgId, is_active: 1 });

    const permissions = await getPermissionsMap(orgId, "kassir");
    expect(permissions.reports).toBe(true);
    expect(Object.entries(permissions).filter(([key]) => key !== "reports").every(([, v]) => v === false)).toBe(
      true
    );
  });

  it("10. dashboard joriy ko'rsatkichi barcha yig'ilmagan pulni qamraydi", async () => {
    await addPayment({ org: orgId, amount: 30000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 4000, method: "online", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 10000, method: "cash", operatorId: operatorB.id });

    expect((await getOrganizationStats(orgId)).today_revenue).toBe(44000);

    await collect(owner, { operator_id: operatorA.id, collected_amount: 30000 });

    expect((await getOrganizationStats(orgId)).today_revenue).toBe(10000);

    await collect(owner, { operator_id: operatorB.id, collected_amount: 10000 });

    expect((await getOrganizationStats(orgId)).today_revenue).toBe(0);
  });

  it("11. inkassatsiya kunlik va oylik hisobotlarni o'zgartirmaydi", async () => {
    await addPayment({ org: orgId, amount: 25000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 5000, method: "online", operatorId: operatorA.id });

    const now = DateTime.now().setZone("Asia/Tashkent");
    const dailyBefore = await reportsService.getDailyReport(owner, orgId, undefined);
    const monthlyBefore = await reportsService.getMonthlyReport(owner, orgId, now.year, now.month);

    await collect(owner, { operator_id: operatorA.id, collected_amount: 25000 });

    const dailyAfter = await reportsService.getDailyReport(owner, orgId, undefined);
    const monthlyAfter = await reportsService.getMonthlyReport(owner, orgId, now.year, now.month);

    expect(dailyAfter.cash_revenue).toBe(25000);
    expect(dailyAfter.online_revenue).toBe(5000);
    expect(dailyAfter.total_revenue).toBe(dailyBefore.total_revenue);
    expect(monthlyAfter.total_revenue).toBe(monthlyBefore.total_revenue);
  });

  it("12. operator_id filtri bilan hisobot faqat shu operator to'lovlarini hisoblaydi", async () => {
    await addPayment({ org: orgId, amount: 11000, method: "cash", operatorId: operatorA.id });
    await addPayment({ org: orgId, amount: 22000, method: "cash", operatorId: operatorB.id });
    await addPayment({ org: orgId, amount: 3000, method: "online", operatorId: operatorA.id });

    expect((await reportsService.getDailyReport(owner, orgId, undefined)).total_revenue).toBe(36000);

    const filtered = await reportsService.getDailyReport(owner, orgId, undefined, operatorA.id);
    expect(filtered.cash_revenue).toBe(11000);
    expect(filtered.online_revenue).toBe(3000);

    const otherFiltered = await reportsService.getDailyReport(owner, orgId, undefined, operatorB.id);
    expect(otherFiltered.total_revenue).toBe(22000);
  });

  it("13. boshqa organization inkassatsiyasiga kirish 404 qaytaradi", async () => {
    const foreignOperator = await createTestUser(otherOrgId, { role: "operator" });
    await addPayment({ org: otherOrgId, amount: 50000, method: "cash", operatorId: foreignOperator.id });

    expect((await pendingSummary(kassir, foreignOperator.id, otherOrgId)).status).toBe(404);
    expect((await listCollections(owner, otherOrgId)).status).toBe(404);
    expect((await operatorsList(kassir, otherOrgId)).status).toBe(404);
    expect(await testDb("tb_cash_collections").where({ org_id: otherOrgId })).toHaveLength(0);
  });

  it("14. oddiy operator inkassatsiya endpointlariga kira olmaydi (403)", async () => {
    expect((await pendingSummary(operatorA, operatorA.id)).status).toBe(403);
    expect((await collect(operatorA, { operator_id: operatorA.id, collected_amount: 1000 })).status).toBe(403);
    expect((await listCollections(operatorA)).status).toBe(403);
    expect((await operatorsList(operatorA)).status).toBe(403);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });

  it("15. collected_amount noto'g'ri bo'lsa 400 qaytaradi", async () => {
    const body = { operator_id: operatorA.id };
    expect((await collect(owner, body)).status).toBe(400);
    expect((await collect(owner, { ...body, collected_amount: -5 })).status).toBe(400);
    expect((await collect(owner, { ...body, collected_amount: "abc" })).status).toBe(400);
    expect(await testDb("tb_cash_collections").where({ org_id: orgId })).toHaveLength(0);
  });

  it("16. foydalanuvchi o'chirilgan bo'lsa ismlar null qaytadi", async () => {
    await addPayment({ org: orgId, amount: 4000, method: "cash", operatorId: operatorA.id });
    await collect(kassir, { operator_id: operatorA.id, collected_amount: 4000 });

    await testDb("tb_users").whereIn("id", [kassirId, operatorA.id]).del();

    const response = await listCollections(owner);
    expect(response.status).toBe(200);
    expect(response.body.collections[0]).toMatchObject({
      operator_id: null,
      operator_id_name: null,
      collected_by: null,
      collected_by_name: null,
    });
    expect(Number(response.body.collections[0].collected_amount)).toBe(4000);
  });
});
