import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerRelay } from "@/modules/relay/relay.service";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("triggerRelay", () => {
  it("relayIp bo'sh bo'lsa — so'rov yubormasdan false qaytaradi", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await triggerRelay(null, 5);

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("muvaffaqiyatli so'rovda true qaytaradi va Shelly Gen1 formatida so'rov yuboradi", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await triggerRelay("192.168.1.50", 5);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.50/relay/0?turn=on&timer=5",
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it("rele muvaffaqiyatsiz javob qaytarsa — false qaytaradi", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await triggerRelay("192.168.1.50", 5);

    expect(result).toBe(false);
  });

  it("timeout/tarmoq xatosida exception tashlamasdan false qaytaradi", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(triggerRelay("192.168.1.50", 5)).resolves.toBe(false);
  });
});
