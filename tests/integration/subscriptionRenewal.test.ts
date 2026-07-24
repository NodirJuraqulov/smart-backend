import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { createPlan, updatePlan } from "@/modules/subscriptionPlans/subscriptionPlans.service";
import { createSubscription, renewSubscription } from "@/modules/subscriptions/subscriptions.service";
import { getDailyReport } from "@/modules/reports/reports.service";
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

describe("renewSubscription", () => {
  it("end_date ni reja duration_days ga qarab to'g'ri uzaytiradi va last_renewed_at ni belgilaydi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });
    const subscription = await createSubscription(operator, { plate_number: "01G100AA", plan_id: plan!.id });
    expect(subscription!.last_renewed_at).toBeNull();

    const expectedNewEndDate = DateTime.fromISO(subscription!.end_date)
      .plus({ days: 30 })
      .toFormat("yyyy-MM-dd");
    const today = DateTime.now().toFormat("yyyy-MM-dd");

    const renewed = await renewSubscription(operator, subscription!.id);

    expect(renewed.end_date).toBe(expectedNewEndDate);
    expect(renewed.last_renewed_at).toBe(today);
    expect(renewed.status).toBe("active");
    expect(renewed.price_snapshot).toBe(subscription!.price_snapshot);
    expect(renewed.plan_name_snapshot).toBe(subscription!.plan_name_snapshot);
    expect(renewed.duration_days_snapshot).toBe(subscription!.duration_days_snapshot);
  });

  it("reja bloklangan bo'lsa — snapshot duration_days bilan uzaytiradi, joriy reja qiymatini emas", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });
    const subscription = await createSubscription(operator, { plate_number: "01G200AA", plan_id: plan!.id });
    await updatePlan(operator, plan!.id, { is_blocked: true, duration_days: 999 });

    const expectedNewEndDate = DateTime.fromISO(subscription!.end_date)
      .plus({ days: 30 })
      .toFormat("yyyy-MM-dd");

    const renewed = await renewSubscription(operator, subscription!.id);

    expect(renewed.end_date).toBe(expectedNewEndDate);
  });
});

describe("hisobot — yaratish va renew ikki marta hisoblanmasligi", () => {
  it("bir kunda yaratilgan VA renew qilingan subscription bitta marta hisoblanadi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });
    const subscription = await createSubscription(operator, { plate_number: "01G300AA", plan_id: plan!.id });

    await renewSubscription(operator, subscription!.id);

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.subscription_revenue).toBe(100000);
  });

  it("boshqa kunda yaratilgan, lekin shu kun renew qilingan subscription hisoblanadi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });
    const subscription = await createSubscription(operator, { plate_number: "01G400AA", plan_id: plan!.id });

    await db("tb_subscriptions")
      .where({ id: subscription!.id })
      .update({ created_at: DateTime.now().minus({ days: 5 }).toJSDate() });

    await renewSubscription(operator, subscription!.id);

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.subscription_revenue).toBe(100000);
  });

  it("yangi va eski-lekin-renew qilingan ikkita subscription to'g'ri qo'shiladi, ustma-ust tushmaydi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });

    await createSubscription(operator, { plate_number: "01G500AA", plan_id: plan!.id });

    const oldSubscription = await createSubscription(operator, {
      plate_number: "01G501AA",
      plan_id: plan!.id,
    });
    await db("tb_subscriptions")
      .where({ id: oldSubscription!.id })
      .update({ created_at: DateTime.now().minus({ days: 5 }).toJSDate() });
    await renewSubscription(operator, oldSubscription!.id);

    const report = await getDailyReport(operator, undefined, undefined);
    expect(report.subscription_revenue).toBe(200000);
  });
});
