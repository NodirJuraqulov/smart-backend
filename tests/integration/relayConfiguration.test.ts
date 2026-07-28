import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { openBarrier } from "@/modules/relay/relay.service";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
  createTestSettings,
} from "./helpers";

let orgId: number;

beforeAll(assertTestDatabase);

afterEach(async () => {
  if (orgId) await cleanupOrganization(orgId);
  vi.unstubAllGlobals();
});

afterAll(closeDb);

describe("openBarrier konfiguratsiyasi", () => {
  it("disabled holatda fetchsiz disabled qaytaradi", async () => {
    orgId = await createTestOrganization();
    await createTestSettings(orgId, { barrier_enabled: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await openBarrier(orgId, "entry")).toEqual({ status: "disabled", success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("yoqilgan, ammo direction IP yo'q bo'lsa fetchsiz not_configured qaytaradi", async () => {
    orgId = await createTestOrganization();
    await createTestSettings(orgId, { barrier_enabled: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await openBarrier(orgId, "exit")).toEqual({ status: "not_configured", success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("entry/exit IP va barrier_open_seconds ni ishlatadi", async () => {
    orgId = await createTestOrganization();
    await createTestSettings(orgId, { barrier_enabled: true, barrier_open_seconds: 7 });
    await db("tb_organizations").where({ id: orgId }).update({
      relay_entry_ip: "192.168.1.10",
      relay_exit_ip: "192.168.1.11",
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await openBarrier(orgId, "entry")).toMatchObject({ status: "opened" });
    expect(await openBarrier(orgId, "exit")).toMatchObject({ status: "opened" });
    expect(fetchMock.mock.calls[0][0]).toContain("192.168.1.10/relay/0?turn=on&timer=7");
    expect(fetchMock.mock.calls[1][0]).toContain("192.168.1.11/relay/0?turn=on&timer=7");
  });
});
