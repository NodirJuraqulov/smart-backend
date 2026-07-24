import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthTokenPayload } from "@/modules/auth/auth.service";
import { createPlan, updatePlan } from "@/modules/subscriptionPlans/subscriptionPlans.service";
import { createSubscription } from "@/modules/subscriptions/subscriptions.service";
import { db } from "@/config/db";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization, createTestUser } from "./helpers";

let orgId: number;
let operator: AuthTokenPayload;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
  const user = await createTestUser(orgId);
  operator = { id: user.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("reja narxini o'zgartirish", () => {
  it("mavjud obunachilarga ta'sir qilmaydi — snapshot saqlanadi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });

    const subscription = await createSubscription(operator, {
      plate_number: "01E100AA",
      plan_id: plan!.id,
    });
    expect(subscription?.price_snapshot).toBe("100000.00");

    await updatePlan(operator, plan!.id, { price: 250000 });

    const unchangedSubscription = await db("tb_subscriptions").where({ id: subscription!.id }).first();
    expect(Number(unchangedSubscription.price_snapshot)).toBe(100000);
  });
});

describe("rejani bloklash", () => {
  it("yangi obunaga to'siq bo'ladi, lekin mavjud obunachiga ta'sir qilmaydi", async () => {
    const plan = await createPlan(operator, { name: "Oylik", duration_days: 30, price: 100000 });

    const existingSubscription = await createSubscription(operator, {
      plate_number: "01E200AA",
      plan_id: plan!.id,
    });

    await updatePlan(operator, plan!.id, { is_blocked: true });

    await expect(
      createSubscription(operator, { plate_number: "01E201AA", plan_id: plan!.id })
    ).rejects.toMatchObject({ statusCode: 400 });

    const stillExists = await db("tb_subscriptions").where({ id: existingSubscription!.id }).first();
    expect(stillExists).toBeTruthy();
    expect(stillExists.plate_number).toBe("01E200AA");
  });
});
