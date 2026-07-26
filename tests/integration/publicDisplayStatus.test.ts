import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "@/middleware/errorHandler";
import publicDisplayRouter from "@/modules/publicDisplay/publicDisplay.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestTariff,
  createTestTariffInterval,
  setOrgCapacity,
  setOrgPricingMode,
} from "./helpers";

let orgId: number;

function buildApp() {
  const app = express();
  app.use("/api/public/display", publicDisplayRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ name: "Test Display Org" });
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/public/display/:orgId/status", () => {
  it("auth siz ishlaydi, hourly tarifda to'g'ri ma'lumot qaytaradi", async () => {
    await createTestTariff(orgId, { price_per_hour: 5000, grace_period_minutes: 10 });
    await setOrgCapacity(orgId, 20);

    const res = await request(buildApp()).get(`/api/public/display/${orgId}/status`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orgName: "Test Display Org",
      pricingMode: "hourly",
      hourlyTariff: { price: 5000, gracePeriodMinutes: 10 },
      capacity: { occupied: 0, total: 20 },
    });
    expect(res.body.intervalTariffs).toBeUndefined();
  });

  it("interval tarifda to'g'ri ma'lumot qaytaradi", async () => {
    await setOrgPricingMode(orgId, "interval");
    await createTestTariffInterval(orgId, { from_minutes: 0, to_minutes: 60, price: 3000 });
    await createTestTariffInterval(orgId, { from_minutes: 60, to_minutes: null, price: 6000 });

    const res = await request(buildApp()).get(`/api/public/display/${orgId}/status`);

    expect(res.status).toBe(200);
    expect(res.body.pricingMode).toBe("interval");
    expect(res.body.hourlyTariff).toBeUndefined();
    expect(res.body.intervalTariffs).toEqual([
      { fromMinutes: 0, toMinutes: 60, price: 3000 },
      { fromMinutes: 60, toMinutes: null, price: 6000 },
    ]);
  });

  it("noto'g'ri orgId — 404 qaytaradi", async () => {
    const res = await request(buildApp()).get("/api/public/display/999999999/status");

    expect(res.status).toBe(404);
  });

  it("orgId son bo'lmasa — 400 qaytaradi", async () => {
    const res = await request(buildApp()).get("/api/public/display/abc/status");

    expect(res.status).toBe(400);
  });
});
