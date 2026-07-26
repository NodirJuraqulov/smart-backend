import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { createOrganization } from "@/modules/organizations/organizations.service";
import { assertTestDatabase, closeDb } from "./helpers";

beforeAll(async () => {
  await assertTestDatabase();
});

afterAll(async () => {
  await closeDb();
});

describe("createOrganization — webhook_token", () => {
  it("avtomatik, 64 hex belgili webhook_token generatsiya qiladi", async () => {
    const result = await createOrganization({
      name: `Webhook Org ${Date.now()}`,
      owner: { name: "Owner", login: `owner_${Date.now()}`, password: "parol12345" },
      tariff: { price_per_hour: 5000 },
    });

    try {
      const row = await db("tb_organizations").where({ id: result.organization!.id }).first();
      expect(row.webhook_token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await db("tb_organizations").where({ id: result.organization!.id }).del();
    }
  });

  it("har bir org uchun turli webhook_token generatsiya qiladi", async () => {
    const first = await createOrganization({
      name: `Webhook Org A ${Date.now()}`,
      owner: { name: "Owner A", login: `owner_a_${Date.now()}`, password: "parol12345" },
      tariff: { price_per_hour: 5000 },
    });
    const second = await createOrganization({
      name: `Webhook Org B ${Date.now()}`,
      owner: { name: "Owner B", login: `owner_b_${Date.now()}`, password: "parol12345" },
      tariff: { price_per_hour: 5000 },
    });

    try {
      const [rowA, rowB] = await Promise.all([
        db("tb_organizations").where({ id: first.organization!.id }).first(),
        db("tb_organizations").where({ id: second.organization!.id }).first(),
      ]);
      expect(rowA.webhook_token).not.toBe(rowB.webhook_token);
    } finally {
      await db("tb_organizations")
        .whereIn("id", [first.organization!.id, second.organization!.id])
        .del();
    }
  });
});
