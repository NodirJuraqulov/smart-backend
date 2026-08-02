import http from "http";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { openBarrier } from "@/modules/relay/relay.service";
import { encryptSecret } from "@/utils/encryption";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

let orgId: number;

beforeAll(assertTestDatabase);

afterEach(async () => {
  if (orgId) await cleanupOrganization(orgId);
  vi.unstubAllGlobals();
});

afterAll(closeDb);

describe("Dahua camera relay konfiguratsiyasi", () => {
  it("host konfiguratsiya qilinmagan exit relay uchun fetchsiz not_configured qaytaradi", async () => {
    orgId = await createTestOrganization();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await openBarrier(orgId, "exit")).toMatchObject({ status: "not_configured", success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("konfiguratsiya qilingan exit relayga Digest authentication bilan haqiqiy HTTP so'rov yuboradi", async () => {
    orgId = await createTestOrganization();
    let authenticatedRequest = false;
    const relayServer = http.createServer((req, res) => {
      if (!req.headers.authorization) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Digest realm="Dahua", nonce="abc123", qop="auth", algorithm=MD5');
        res.end();
        return;
      }
      authenticatedRequest = /^Digest /.test(req.headers.authorization);
      res.statusCode = 200;
      res.end("OK");
    });
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    const port = (relayServer.address() as AddressInfo).port;
    await db("tb_organizations").where({ id: orgId }).update({
      exit_camera_relay_host: "127.0.0.1",
      exit_camera_relay_port: port,
      exit_camera_relay_username: "admin",
      exit_camera_relay_password_encrypted: encryptSecret("secret"),
      exit_camera_relay_channel: 2,
    });
    try {
      const result = await openBarrier(orgId, "exit");
      expect(result).toMatchObject({ status: "opened", success: true });
      expect(authenticatedRequest).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => relayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
