import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/config/db";
import { errorHandler } from "@/middleware/errorHandler";
import { AuthTokenPayload, signAccessToken } from "@/modules/auth/auth.service";
import plateFormatsRouter from "@/modules/plateFormats/plateFormats.routes";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestUser,
} from "./helpers";

let orgId: number;
let otherOrgId: number;
let superAdmin: AuthTokenPayload;
let owner: AuthTokenPayload;
let operator: AuthTokenPayload;

const app = express();
app.use(express.json());
app.use("/api/organizations", plateFormatsRouter);
app.use(errorHandler);

function authorization(actor: AuthTokenPayload): string {
  return `Bearer ${signAccessToken(actor)}`;
}

function formatsPath(targetOrgId = orgId): string {
  return `/api/organizations/${targetOrgId}/plate-formats`;
}

function settingPath(targetOrgId = orgId): string {
  return `/api/organizations/${targetOrgId}/plate-format-validation-setting`;
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  otherOrgId = await createTestOrganization();
  const adminUser = await createTestUser(null, { role: "super_admin" });
  const ownerUser = await createTestUser(orgId, { role: "owner" });
  const operatorUser = await createTestUser(orgId, { role: "operator" });
  superAdmin = { id: adminUser.id, org_id: null, role: "super_admin" };
  owner = { id: ownerUser.id, org_id: orgId, role: "owner" };
  operator = { id: operatorUser.id, org_id: orgId, role: "operator" };
});

afterEach(async () => {
  await cleanupOrganization(orgId);
  await cleanupOrganization(otherOrgId);
  await db("tb_users").whereNull("org_id").del();
});

afterAll(closeDb);

describe("plate format CRUD", () => {
  it("Super Admin format qo'shadi, tahrirlaydi, o'chiradi", async () => {
    const created = await request(app)
      .post(formatsPath())
      .set("Authorization", authorization(superAdmin))
      .send({ pattern: "nnlnnnll", description: "Standart" });
    expect(created.status).toBe(201);
    expect(created.body.format).toMatchObject({
      org_id: orgId,
      pattern: "NNLNNNLL",
      description: "Standart",
      is_active: true,
    });

    const formatId = created.body.format.id;
    const updated = await request(app)
      .patch(`${formatsPath()}/${formatId}`)
      .set("Authorization", authorization(superAdmin))
      .send({ description: "Yangilangan", is_active: false });
    expect(updated.body.format).toMatchObject({
      id: formatId,
      description: "Yangilangan",
      is_active: false,
    });

    const listed = await request(app)
      .get(formatsPath())
      .set("Authorization", authorization(operator));
    expect(listed.status).toBe(200);
    expect(listed.body.formats).toHaveLength(1);

    const deleted = await request(app)
      .delete(`${formatsPath()}/${formatId}`)
      .set("Authorization", authorization(superAdmin));
    expect(deleted.status).toBe(204);
    expect(await db("tb_plate_formats").where({ id: formatId }).first()).toBeUndefined();
  });

  it.each([
    ["owner", () => owner],
    ["operator", () => operator],
  ])("%s POST PATCH DELETE qila olmaydi", async (_role, actor) => {
    const formatId = (
      await request(app)
        .post(formatsPath())
        .set("Authorization", authorization(superAdmin))
        .send({ pattern: "NNLNNNLL" })
    ).body.format.id;
    expect(
      (
        await request(app)
          .post(formatsPath())
          .set("Authorization", authorization(actor()))
          .send({ pattern: "NNNNNLLL" })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`${formatsPath()}/${formatId}`)
          .set("Authorization", authorization(actor()))
          .send({ is_active: false })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .delete(`${formatsPath()}/${formatId}`)
          .set("Authorization", authorization(actor()))
      ).status
    ).toBe(403);
  });

  it("pattern DSL va duplicate formatni tekshiradi", async () => {
    const invalid = await request(app)
      .post(formatsPath())
      .set("Authorization", authorization(superAdmin))
      .send({ pattern: "[A-Z]+" });
    expect(invalid.status).toBe(400);

    await request(app)
      .post(formatsPath())
      .set("Authorization", authorization(superAdmin))
      .send({ pattern: "NNLNNNLL" });
    const duplicate = await request(app)
      .post(formatsPath())
      .set("Authorization", authorization(superAdmin))
      .send({ pattern: "nnlnnnll" });
    expect(duplicate.status).toBe(409);
  });
});

describe("plate format validation setting", () => {
  it("default false va faqat Super Admin o'zgartira oladi", async () => {
    for (const actor of [superAdmin, owner, operator]) {
      const response = await request(app)
        .get(settingPath())
        .set("Authorization", authorization(actor));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ enabled: false });
    }

    expect(
      (
        await request(app)
          .patch(settingPath())
          .set("Authorization", authorization(owner))
          .send({ enabled: true })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(settingPath())
          .set("Authorization", authorization(operator))
          .send({ enabled: true })
      ).status
    ).toBe(403);

    const updated = await request(app)
      .patch(settingPath())
      .set("Authorization", authorization(superAdmin))
      .send({ enabled: true });
    expect(updated.body).toEqual({ enabled: true });

    const [eventId] = await db("tb_webhook_events").insert({
      org_id: orgId,
      plate_number: "INVALID1",
      direction: "entry",
    });
    await db("tb_plate_format_checks").insert({
      org_id: orgId,
      direction: "entry",
      device_id: "setting-test",
      reference_plate: "INVALID1",
      last_detected_plate: "INVALID1",
      last_webhook_event_id: eventId,
      attempts: 1,
      first_seen_at: new Date(),
      deadline_at: new Date(Date.now() + 3000),
    });
    await request(app)
      .patch(settingPath())
      .set("Authorization", authorization(superAdmin))
      .send({ enabled: false });
    expect(await db("tb_plate_format_checks").where({ org_id: orgId })).toHaveLength(0);
  });

  it("cross-org format va setting kirishlarini 404 qiladi", async () => {
    const [foreignFormatId] = await db("tb_plate_formats").insert({
      org_id: otherOrgId,
      pattern: "NNLNNNLL",
    });
    expect(
      (
        await request(app)
          .get(formatsPath(otherOrgId))
          .set("Authorization", authorization(owner))
      ).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`${formatsPath()}/${foreignFormatId}`)
          .set("Authorization", authorization(superAdmin))
          .send({ is_active: false })
      ).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(settingPath(otherOrgId))
          .set("Authorization", authorization(operator))
      ).status
    ).toBe(404);
  });
});
