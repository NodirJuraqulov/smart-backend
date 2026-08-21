import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/config/db";
import { sendExitNotification } from "@/modules/telegram/telegram.service";
import { encryptSecret } from "@/utils/encryption";
import {
  assertTestDatabase,
  cleanupOrganization,
  closeDb,
  createTestOrganization,
} from "./helpers";

let orgId: number;
let fetchMock: ReturnType<typeof vi.fn>;

function successfulResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

async function configure(token: string | null, chatIds: string[] | null): Promise<void> {
  await db("tb_organizations").where({ id: orgId }).update({
    telegram_bot_token: token ? encryptSecret(token) : null,
    telegram_chat_ids: chatIds === null ? null : JSON.stringify(chatIds),
  });
}

beforeAll(assertTestDatabase);

beforeEach(async () => {
  orgId = await createTestOrganization();
  fetchMock = vi.fn().mockResolvedValue(successfulResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupOrganization(orgId);
});

afterAll(closeDb);

describe("Telegram exit notification", () => {
  it("ikkita Chat ID uchun sendPhoto so'rovlarini parallel yuboradi", async () => {
    await configure("123456789:TEST_token", ["1652032889", "-987654321"]);

    await sendExitNotification(orgId, {
      plateNumber: "01A123BC",
      amount: 15000,
      paymentMethod: "cash",
      imageUrl: "https://example.com/exit.jpg",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    }));
    expect(requests.every((request) => request.url.endsWith("/sendPhoto"))).toBe(true);
    expect(requests.map((request) => request.body.chat_id)).toEqual([
      "1652032889",
      "-987654321",
    ]);
    expect(requests[0].body.caption).toBe(
      "Mashina raqami: 01A123BC\nSumma: 15000 so'm\nTo'lov turi: Naqd"
    );
  });

  it("bir Chat ID xato bersa ikkinchisiga yuborishda davom etadi", async () => {
    await configure("123456789:TEST_token", ["111", "222"]);
    fetchMock
      .mockRejectedValueOnce(new Error("Telegram offline"))
      .mockResolvedValueOnce(successfulResponse());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      sendExitNotification(orgId, {
        plateNumber: "01B123BC",
        amount: 20000,
        paymentMethod: "online",
        imageUrl: null,
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("TELEGRAM_SEND_FAILED chat_id=111");
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/sendMessage"))).toBe(true);
  });

  it("token yoki Chat ID sozlanmagan bo'lsa tashqi so'rov yubormaydi", async () => {
    await configure(null, ["111"]);
    await sendExitNotification(orgId, {
      plateNumber: "01C123BC",
      amount: 0,
      paymentMethod: "cash",
      imageUrl: null,
    });

    await configure("123456789:TEST_token", null);
    await sendExitNotification(orgId, {
      plateNumber: "01C123BC",
      amount: 0,
      paymentMethod: "cash",
      imageUrl: null,
    });

    await configure("123456789:TEST_token", []);
    await sendExitNotification(orgId, {
      plateNumber: "01C123BC",
      amount: 0,
      paymentMethod: "cash",
      imageUrl: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
