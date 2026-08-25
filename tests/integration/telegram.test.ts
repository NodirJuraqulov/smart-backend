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
      durationText: "2 soat 15 daqiqa",
      confirmedByName: "Test Operator",
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
      "Mashina raqami: 01A123BC\nSumma: 15000 so'm\nTo'lov turi: Naqd\nTurgan vaqt: 2 soat 15 daqiqa\nTasdiqladi: Test Operator"
    );
  });

  it("majburiy ochish uchun summa, to'lov turi va noma'lum davomiylikni formatlaydi", async () => {
    await configure("123456789:TEST_token", ["1652032889"]);

    await sendExitNotification(orgId, {
      plateNumber: "01F123BC",
      amount: null,
      paymentMethod: null,
      imageUrl: null,
      durationText: "Noma'lum",
      confirmedByName: "Test Owner",
    });

    const request = fetchMock.mock.calls[0];
    if (!request) throw new Error("Telegram so'rovi yuborilmadi");
    const body = JSON.parse(String(request[1].body)) as Record<string, unknown>;
    expect(body.text).toBe(
      "Mashina raqami: 01F123BC\nSumma: —\nTo'lov turi: Majburiy ochish\nTurgan vaqt: Noma'lum\nTasdiqladi: Test Owner"
    );
  });

  it("emergency chiqishni Tez yordam deb formatlaydi", async () => {
    await configure("123456789:TEST_token", ["1652032889"]);

    await sendExitNotification(orgId, {
      plateNumber: "01E123BC",
      amount: 0,
      paymentMethod: null,
      exitMethod: "emergency",
      imageUrl: null,
      durationText: "5 daqiqa",
      confirmedByName: "Test Owner",
    });

    const request = fetchMock.mock.calls[0];
    if (!request) throw new Error("Telegram so'rovi yuborilmadi");
    const body = JSON.parse(String(request[1].body)) as Record<string, unknown>;
    expect(body.text).toBe(
      "Mashina raqami: 01E123BC\nSumma: 0 so'm\nTo'lov turi: Tez yordam\nTurgan vaqt: 5 daqiqa\nTasdiqladi: Test Owner"
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
        confirmedByName: "Test Operator",
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
      confirmedByName: "Test Operator",
    });

    await configure("123456789:TEST_token", null);
    await sendExitNotification(orgId, {
      plateNumber: "01C123BC",
      amount: 0,
      paymentMethod: "cash",
      imageUrl: null,
      confirmedByName: "Test Operator",
    });

    await configure("123456789:TEST_token", []);
    await sendExitNotification(orgId, {
      plateNumber: "01C123BC",
      amount: 0,
      paymentMethod: "cash",
      imageUrl: null,
      confirmedByName: "Test Operator",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
