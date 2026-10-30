import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import reportsRouter from "@/modules/reports/reports.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

const app = express();
app.use(express.json());
app.use("/api/reports", reportsRouter);
app.use(errorHandler);

let orgId: number;
let otherOrgId: number;
let owner: AuthTokenPayload;
let kassir: AuthTokenPayload;
let operator: AuthTokenPayload;
let secondOperator: AuthTokenPayload;

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function activity(actorId: number, createdAt: Date, action = "test.action") {
  await db("tb_activity_logs").insert({
    actor_id: actorId,
    action,
    target_type: "test",
    created_at: createdAt,
  });
}

async function completedSession(plate: string, exitedAt: Date): Promise<number> {
  const [id] = await db("tb_parking_sessions").insert({
    org_id: orgId,
    plate_number: plate,
    entered_at: new Date(exitedAt.getTime() - 60 * 60 * 1000),
    exited_at: exitedAt,
    duration_minutes: 60,
    amount: 0,
    status: "completed",
    entry_method: "auto",
    exit_method: "forced",
    session_source: "regular",
    active_plate_key: null,
  });
  return id;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "Asia/Tashkent" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const kassirUser = await createTestUser(orgId, { role: "kassir" });
  const first = await createTestUser(orgId, { role: "operator" });
  const second = await createTestUser(orgId, { role: "operator" });
  await db("tb_users").where({ id: first.id }).update({ name: "Birinchi Operator" });
  await db("tb_users").where({ id: second.id }).update({ name: "Ikkinchi Operator" });
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  kassir = { id: kassirUser.id, org_id: orgId, role: "kassir" };
  operator = { id: first.id, org_id: orgId, role: "operator" };
  secondOperator = { id: second.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(async () => {
  await closeDb();
});

describe("shift reports", () => {
  it("faqat operator rolidagi eng ko'p smena amalini tanlaydi va tenglikda kichik id ni oladi", async () => {
    const otherOrgOperator = await createTestUser(otherOrgId, { role: "operator" });
    await activity(operator.id, new Date("2026-10-30T02:59:59.000Z"));
    await activity(operator.id, new Date("2026-10-30T03:00:00.000Z"));
    await activity(operator.id, new Date("2026-10-30T10:00:00.000Z"));
    await activity(secondOperator.id, new Date("2026-10-30T04:00:00.000Z"));
    await activity(secondOperator.id, new Date("2026-10-31T02:59:59.000Z"));
    await activity(kassir.id, new Date("2026-10-30T05:00:00.000Z"));
    await activity(kassir.id, new Date("2026-10-30T06:00:00.000Z"));
    await activity(kassir.id, new Date("2026-10-30T07:00:00.000Z"));
    await activity(otherOrgOperator.id, new Date("2026-10-30T08:00:00.000Z"));
    await activity(operator.id, new Date("2026-10-31T03:00:00.000Z"));

    const response = await request(app)
      .get("/api/reports/shift-operator?date=2026-10-30")
      .set("Authorization", authorization(owner));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      date: "2026-10-30",
      operator: { id: operator.id, name: "Birinchi Operator" },
      actions: 2,
    });
  });

  it("operator amali bo'lmasa null va nol qaytaradi", async () => {
    await activity(kassir.id, new Date("2026-10-30T05:00:00.000Z"));

    const response = await request(app)
      .get("/api/reports/shift-operator?date=2026-10-30")
      .set("Authorization", authorization(kassir));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ date: "2026-10-30", operator: null, actions: 0 });
  });

  it("smena pulini operator bo'yicha ajratmaydi va faqat berilgan operator review jamini qo'shadi", async () => {
    const insideSession = await completedSession("01SHIFT1", new Date("2026-10-30T05:00:00.000Z"));
    await completedSession("01SHIFT2", new Date("2026-10-31T02:59:59.000Z"));
    await completedSession("01OUT001", new Date("2026-10-31T03:00:00.000Z"));
    await db("tb_payments").insert([
      {
        org_id: orgId,
        session_id: insideSession,
        amount: 275000,
        payment_method: "cash",
        paid_at: new Date("2026-10-30T03:00:00.000Z"),
        operator_id: operator.id,
      },
      {
        org_id: orgId,
        session_id: insideSession,
        amount: 605000,
        payment_method: "online",
        paid_at: new Date("2026-10-30T10:00:00.000Z"),
        operator_id: secondOperator.id,
      },
      {
        org_id: orgId,
        session_id: insideSession,
        amount: 40000,
        payment_method: "card",
        paid_at: new Date("2026-10-31T02:59:59.000Z"),
        operator_id: null,
      },
      {
        org_id: orgId,
        session_id: insideSession,
        amount: 999999,
        payment_method: "cash",
        paid_at: new Date("2026-10-31T03:00:00.000Z"),
        operator_id: operator.id,
      },
    ]);
    await db("forced_open_reviews").insert([
      {
        org_id: orgId,
        candidate_id: 900001,
        operator_id: operator.id,
        operator_name: "Birinchi Operator",
        forced_at: new Date("2026-10-30T06:00:00.000Z"),
        amount_som: 12000,
        kind: "not_found",
        saved_by: owner.id,
      },
      {
        org_id: orgId,
        candidate_id: 900002,
        operator_id: operator.id,
        operator_name: "Birinchi Operator",
        forced_at: new Date("2026-10-30T07:00:00.000Z"),
        amount_som: 24000,
        kind: "session_found",
        saved_by: owner.id,
      },
      {
        org_id: orgId,
        candidate_id: 900003,
        operator_id: secondOperator.id,
        operator_name: "Ikkinchi Operator",
        forced_at: new Date("2026-10-30T08:00:00.000Z"),
        amount_som: 50000,
        kind: "not_found",
        saved_by: owner.id,
      },
    ]);

    const response = await request(app)
      .get(`/api/reports/shift?date=2026-10-30&operator_id=${operator.id}`)
      .set("Authorization", authorization(kassir));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      date: "2026-10-30",
      from: "2026-10-30T03:00:00.000Z",
      to: "2026-10-31T03:00:00.000Z",
      cash_revenue: 275000,
      online_revenue: 605000,
      card_revenue: 40000,
      total_revenue: 920000,
      exits_count: 2,
      forced_open_saved: {
        operator_id: operator.id,
        count: 2,
        amount_som: 36000,
      },
    });
  });

  it("operator_id berilmasa yoki saqlangan review bo'lmasa forced_open_saved null bo'ladi", async () => {
    const withoutOperator = await request(app)
      .get("/api/reports/shift?date=2026-10-30")
      .set("Authorization", authorization(owner));
    const withoutSaved = await request(app)
      .get(`/api/reports/shift?date=2026-10-30&operator_id=${operator.id}`)
      .set("Authorization", authorization(owner));

    expect(withoutOperator.status).toBe(200);
    expect(withoutOperator.body.forced_open_saved).toBeNull();
    expect(withoutSaved.status).toBe(200);
    expect(withoutSaved.body.forced_open_saved).toBeNull();
  });

  it("ikkala endpointda date majburiy", async () => {
    for (const path of ["/api/reports/shift-operator", "/api/reports/shift"]) {
      const response = await request(app).get(path).set("Authorization", authorization(owner));
      expect(response.status).toBe(400);
    }
  });
});
