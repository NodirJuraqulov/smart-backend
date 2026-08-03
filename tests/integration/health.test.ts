import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "@/app";
import { createHealthHandler } from "@/modules/health/health.controller";
import { assertTestDatabase, closeDb } from "./helpers";

beforeAll(assertTestDatabase);
afterAll(closeDb);

function expectIsoTimestamp(value: unknown) {
  expect(typeof value).toBe("string");
  expect(new Date(value as string).toISOString()).toBe(value);
}

describe("GET /health", () => {
  it("database ulanganida 200 qaytaradi", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", database: "connected" });
    expect(Object.keys(response.body).sort()).toEqual(["database", "status", "timestamp"]);
    expectIsoTimestamp(response.body.timestamp);
  });

  it("database uzilganda 503 qaytaradi", async () => {
    const databaseCheck = vi.fn(async () => {
      throw new Error("Database unavailable");
    });
    const degradedApp = express();
    degradedApp.get("/health", createHealthHandler(databaseCheck));

    const response = await request(degradedApp).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: "degraded", database: "disconnected" });
    expect(Object.keys(response.body).sort()).toEqual(["database", "status", "timestamp"]);
    expectIsoTimestamp(response.body.timestamp);
    expect(databaseCheck).toHaveBeenCalledOnce();
  });
});
