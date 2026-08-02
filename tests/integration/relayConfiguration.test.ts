import http from "http";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { openBarrier } from "@/modules/relay/relay.service";
import { encryptSecret } from "@/utils/encryption";
import { assertTestDatabase, cleanupOrganization, closeDb, createTestOrganization } from "./helpers";

let orgId: number;

async function readRpcBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendRpc(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

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

  it("konfiguratsiya qilingan exit relayga RPC2 login va openStrobe so'rovlarini yuboradi", async () => {
    orgId = await createTestOrganization();
    const requests: Record<string, unknown>[] = [];
    const relayServer = http.createServer(async (req, res) => {
      const body = await readRpcBody(req);
      requests.push(body);
      if (body.id === 1) {
        sendRpc(res, {
          result: false,
          params: { random: "ABC123", realm: "Dahua", encryption: "Default" },
          session: "temporary-session",
        });
        return;
      }
      if (body.id === 2) {
        sendRpc(res, { result: true, session: "authenticated-session" });
        return;
      }
      sendRpc(res, { result: true });
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
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({ method: "global.login", id: 1 });
      expect(requests[1]).toMatchObject({ method: "global.login", id: 2, session: "temporary-session" });
      expect(requests[2]).toEqual({
        method: "trafficSnap.openStrobe",
        params: { info: { openType: "Test", plateNumber: "" } },
        id: 3,
        session: "authenticated-session",
      });
    } finally {
      await new Promise<void>((resolve, reject) => relayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
