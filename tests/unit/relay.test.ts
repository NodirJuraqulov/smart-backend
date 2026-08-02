import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateDahuaLoginHash, openRelay } from "@/modules/relay/dahuaRelay.service";

function rpcResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): Record<string, unknown> {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error(`RPC2 ${index + 1}-so'rov body topilmadi`);
  return JSON.parse(body) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Dahua RPC2 openRelay", () => {
  it("login challenge, login va openStrobe muvaffaqiyatli bo'lsa opened qaytaradi", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        rpcResponse({
          result: false,
          params: { random: "ABC123", realm: "Login to 192.168.1.50", encryption: "Default" },
          session: "temporary-session",
        })
      )
      .mockResolvedValueOnce(rpcResponse({ result: true, session: "authenticated-session" }))
      .mockResolvedValueOnce(rpcResponse({ result: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRelay({
      host: "192.168.1.50",
      port: 80,
      username: "admin",
      password: "secret",
      channel: 2,
    });

    expect(result).toEqual({ status: "opened", detail: "Kamera shlagbaumni ochdi" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("http://192.168.1.50/RPC2");
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers).toEqual({ "Content-Type": "application/json" });
    }
    expect(requestBody(fetchMock, 0)).toEqual({
      method: "global.login",
      params: { userName: "admin", password: "", clientType: "Web3.0" },
      id: 1,
    });
    expect(requestBody(fetchMock, 1)).toEqual({
      method: "global.login",
      params: {
        userName: "admin",
        password: "CA78B638E58339A935541FA541FE233B",
        clientType: "Web3.0",
        authorityType: "Default",
      },
      id: 2,
      session: "temporary-session",
    });
    expect(requestBody(fetchMock, 2)).toEqual({
      method: "trafficSnap.openStrobe",
      params: { info: { openType: "Test", plateNumber: "" } },
      id: 3,
      session: "authenticated-session",
    });
  });

  it("login birinchi bosqichida tarmoq xatosi aniq failed detail qaytaradi", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openRelay({ host: "192.168.1.50", username: "admin", password: "secret" })
    ).resolves.toEqual({ status: "failed", detail: "Kameraga ulanib bo'lmadi" });
  });

  it("login ikkinchi bosqichi result false qaytarsa autentifikatsiya xatosini qaytaradi", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        rpcResponse({ params: { random: "ABC123", realm: "Login" }, session: "temporary-session" })
      )
      .mockResolvedValueOnce(rpcResponse({ result: false, session: "temporary-session" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openRelay({ host: "192.168.1.50", username: "admin", password: "wrong" })
    ).resolves.toEqual({
      status: "failed",
      detail: "Kamera autentifikatsiyasi muvaffaqiyatsiz (login/parol xato)",
    });
  });

  it("openStrobe result false qaytarsa kamera rad etganini qaytaradi", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpcResponse({ params: { random: "ABC123", realm: "Login" }, session: "temp" }))
      .mockResolvedValueOnce(rpcResponse({ result: true, session: "authenticated" }))
      .mockResolvedValueOnce(rpcResponse({ result: false, error: { code: 500 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openRelay({ host: "192.168.1.50", username: "admin", password: "secret" })
    ).resolves.toEqual({ status: "failed", detail: "Kamera shlagbaumni ochishni rad etdi" });
  });

  it("openStrobe timeout bo'lsa buyruq yuborilmaganini qaytaradi", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpcResponse({ params: { random: "ABC123", realm: "Login" }, session: "temp" }))
      .mockResolvedValueOnce(rpcResponse({ result: true, session: "authenticated" }))
      .mockImplementationOnce((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = openRelay({ host: "192.168.1.50", username: "admin", password: "secret" });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toEqual({
      status: "failed",
      detail: "Shlagbaum ochish buyrug'i yuborilmadi",
    });
  });

  it("host yoki credential yetishmasa fetchsiz not_configured qaytaradi", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(openRelay({ host: null, username: "admin", password: "secret" })).resolves.toMatchObject({
      status: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Dahua Default login MD5 hashini katta harfda to'g'ri hisoblaydi", () => {
    expect(calculateDahuaLoginHash("admin", "Login to 192.168.1.50", "secret", "ABC123")).toBe(
      "CA78B638E58339A935541FA541FE233B"
    );
  });
});
