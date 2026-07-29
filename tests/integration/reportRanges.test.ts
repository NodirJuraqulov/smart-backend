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

let orgId: number;
let otherOrgId: number;
let actor: AuthTokenPayload;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/reports", reportsRouter);
  instance.use(errorHandler);
  return instance;
}

function authHeader(): string {
  return `Bearer ${signAccessToken(actor)}`;
}

async function createCompletedSession(
  targetOrgId: number,
  enteredAt: string,
  exitedAt: string,
  amount: number,
  paymentMethod: "cash" | "online" = "cash",
  paidAt = exitedAt
) {
  const [sessionId] = await db("tb_parking_sessions").insert({
    org_id: targetOrgId,
    plate_number: `R${Date.now()}${Math.random().toString(36).slice(2, 6)}`.slice(0, 20),
    entered_at: new Date(enteredAt),
    exited_at: new Date(exitedAt),
    duration_minutes: 60,
    amount,
    status: "completed",
    entry_method: "manual",
    exit_method: "manual",
    session_source: "regular",
    payment_method: paymentMethod,
  });
  await db("tb_payments").insert({
    org_id: targetOrgId,
    session_id: sessionId,
    amount,
    payment_method: "cash",
    paid_at: new Date(paidAt),
  });
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  otherOrgId = await createTestOrganization({ timezone: "UTC" });
  const user = await createTestUser(orgId);
  actor = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
});

afterAll(closeDb);

describe("daily report range", () => {
  it("eski default va single-date query contractlarini saqlaydi", async () => {
    const defaultReport = await request(app())
      .get("/api/reports/daily")
      .set("Authorization", authHeader());
    expect(defaultReport.status).toBe(200);
    expect(defaultReport.body).toHaveProperty("date");
    expect(defaultReport.body).toHaveProperty("hourly_breakdown");

    const selectedDate = await request(app())
      .get("/api/reports/daily?date=2026-07-01")
      .set("Authorization", authHeader());
    expect(selectedDate.status).toBe(200);
    expect(selectedDate.body.date).toBe("2026-07-01");
  });

  it("3 kunlik inclusive range, zero kunlar va totalsni qaytaradi", async () => {
    await createCompletedSession(orgId, "2026-07-01T10:00:00Z", "2026-07-01T11:00:00Z", 5000);
    await createCompletedSession(orgId, "2026-07-03T10:00:00Z", "2026-07-03T11:00:00Z", 7000, "online");
    await createCompletedSession(otherOrgId, "2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z", 99999);
    await db("tb_parking_sessions").insert({
      org_id: orgId,
      plate_number: "01UNPAID",
      entered_at: new Date("2026-07-02T10:00:00Z"),
      exited_at: new Date("2026-07-02T11:00:00Z"),
      duration_minutes: 60,
      amount: 50000,
      status: "awaiting_payment",
      entry_method: "manual",
      exit_method: "manual",
      session_source: "regular",
      payment_method: "cash",
    });

    const res = await request(app())
      .get("/api/reports/daily?from_date=2026-07-01&to_date=2026-07-03")
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(res.body.period).toEqual({ type: "daily", from: "2026-07-01", to: "2026-07-03" });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[1]).toMatchObject({ date: "2026-07-02", entries: 1, exits: 1, revenue: 0 });
    expect(res.body.total_entries).toBe(3);
    expect(res.body.total_revenue).toBe(12000);
    expect(res.body.total_revenue).toBe(
      res.body.items.reduce((sum: number, item: { revenue: number }) => sum + item.revenue, 0)
    );
  });

  it("15 kunlik range 15 ta continuous item qaytaradi", async () => {
    const res = await request(app())
      .get("/api/reports/daily?from_date=2026-07-01&to_date=2026-07-15")
      .set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(15);
  });

  it.each([
    "from_date=2026-07-02",
    "from_date=2026-07-03&to_date=2026-07-01",
    "from_date=2026-02-30&to_date=2026-03-01",
    "from_date=2024-01-01&to_date=2025-01-01",
  ])("noto'g'ri daily range uchun 400: %s", async (query) => {
    const res = await request(app()).get(`/api/reports/daily?${query}`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });
});

describe("monthly report range", () => {
  it("eski monthly default contractini saqlaydi", async () => {
    const res = await request(app()).get("/api/reports/monthly").set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("year");
    expect(res.body).toHaveProperty("month");
    expect(res.body).toHaveProperty("daily_breakdown");
  });

  it("January-March va cross-year range'larni inclusive qaytaradi", async () => {
    const first = await request(app())
      .get("/api/reports/monthly?from_month=2026-01&to_month=2026-03")
      .set("Authorization", authHeader());
    expect(first.status).toBe(200);
    expect(first.body.items.map((item: { month: string }) => item.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);

    const crossYear = await request(app())
      .get("/api/reports/monthly?from_month=2025-11&to_month=2026-02")
      .set("Authorization", authHeader());
    expect(crossYear.body.items).toHaveLength(4);
  });

  it.each([
    "from_month=2026-01",
    "from_month=2026-13&to_month=2026-14",
    "from_month=2026-03&to_month=2026-01",
  ])("noto'g'ri monthly range uchun 400: %s", async (query) => {
    const res = await request(app()).get(`/api/reports/monthly?${query}`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });
});

describe("yearly report range", () => {
  it("eski yearly default contractini saqlaydi", async () => {
    const res = await request(app()).get("/api/reports/yearly").set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("year");
    expect(res.body).toHaveProperty("monthly_breakdown");
  });

  it("2024-2026 uch yilni inclusive va zero-safe qaytaradi", async () => {
    const res = await request(app())
      .get("/api/reports/yearly?from_year=2024&to_year=2026")
      .set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { year: number }) => item.year)).toEqual([2024, 2025, 2026]);
    expect(res.body.total_revenue).toBe(0);
  });

  it.each([
    "from_year=2024",
    "from_year=20x4&to_year=2026",
    "from_year=2026&to_year=2024",
    "from_year=2000&to_year=2020",
  ])("noto'g'ri yearly range uchun 400: %s", async (query) => {
    const res = await request(app()).get(`/api/reports/yearly?${query}`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });
});
