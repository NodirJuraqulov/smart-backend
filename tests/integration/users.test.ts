import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOperator,
  listOperators,
  toggleBlockOperator,
  updateOperator,
} from "@/modules/users/users.service";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization, createTestUser } from "./helpers";

let orgId: number;

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  orgId = await createTestOrganization();
});

afterEach(async () => {
  await cleanupOrganization(orgId);
});

afterAll(async () => {
  await closeDb();
});

describe("listOperators", () => {
  it("operator VA owner ikkalasini ham qaytaradi", async () => {
    const operatorUser = await createTestUser(orgId, { role: "operator" });
    const ownerUser = await createTestUser(orgId, { role: "owner" });

    const operators = await listOperators();

    expect(operators.some((u) => u.id === operatorUser.id && u.role === "operator")).toBe(true);
    expect(operators.some((u) => u.id === ownerUser.id && u.role === "owner")).toBe(true);
  });

  it("super_admin ro'yxatda ko'rinmaydi", async () => {
    const adminUser = await createTestUser(null, { role: "super_admin" });

    const operators = await listOperators();

    expect(operators.some((u) => u.id === adminUser.id)).toBe(false);
  });
});

describe("toggleBlockOperator", () => {
  it("owner foydalanuvchini ham bloklay/blokdan chiqara oladi", async () => {
    const ownerUser = await createTestUser(orgId, { role: "owner" });

    const blocked = await toggleBlockOperator(ownerUser.id, false);
    expect(blocked.is_active).toBe(false);
    expect(blocked.role).toBe("owner");

    const unblocked = await toggleBlockOperator(ownerUser.id, true);
    expect(unblocked.is_active).toBe(true);
  });

  it("mavjud bo'lmagan yoki super_admin id uchun 404 xato", async () => {
    const adminUser = await createTestUser(null, { role: "super_admin" });

    await expect(toggleBlockOperator(adminUser.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("updateOperator (parolni tiklash)", () => {
  it("owner foydalanuvchining ma'lumotlarini yangilaydi", async () => {
    const ownerUser = await createTestUser(orgId, { role: "owner" });

    const updated = await updateOperator(ownerUser.id, { name: "Yangilangan Ism" });
    expect(updated.role).toBe("owner");
    expect(updated.name).toBe("Yangilangan Ism");
  });

  it("super_admin id uchun 404 xato (faqat operator/owner boshqariladi)", async () => {
    const adminUser = await createTestUser(null, { role: "super_admin" });

    await expect(updateOperator(adminUser.id, { name: "Xato" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("createOperator — regressiyasiz", () => {
  it("hozirgidek faqat role='operator' yaratadi", async () => {
    const operator = await createOperator({
      org_id: orgId,
      name: "Test Operator",
      login: `users_test_op_${Date.now()}`,
      password: "parol12345",
    });

    expect(operator.role).toBe("operator");
    expect(operator.org_id).toBe(orgId);
  });
});
