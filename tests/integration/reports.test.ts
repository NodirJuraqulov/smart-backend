import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { createPlan } from "@/modules/subscriptionPlans/subscriptionPlans.service";
import { createSubscription } from "@/modules/subscriptions/subscriptions.service";
import { getDailyReport, getMonthlyReport } from "@/modules/reports/reports.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization, createTestUser } from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization({ timezone: "UTC" });
  const user = await createTestUser(orgId);
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("hisobotlarda obuna to'lovlari", () => {
  it("kunlik hisobotda subscription_revenue va total_revenue to'g'ri qo'shiladi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 150000 });
    await createSubscription(operator, { plate_number: "01F100AA", plan_id: plan!.id });

    const report = await getDailyReport(operator, undefined, undefined);

    expect(report.regular_revenue).toBe(0);
    expect(report.subscription_revenue).toBe(150000);
    expect(report.total_revenue).toBe(150000);
  });

  it("oylik hisobotda ham subscription_revenue qo'shiladi", async () => {
    const plan = await createPlan(operator, { name: "3 oylik", duration_days: 90, price: 300000 });
    await createSubscription(operator, { plate_number: "01F200AA", plan_id: plan!.id });

    const report = await getMonthlyReport(operator, undefined, undefined, undefined);

    expect(report.subscription_revenue).toBe(300000);
    expect(report.total_revenue).toBe(report.regular_revenue + 300000);
  });
});
