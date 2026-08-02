import { afterEach, describe, expect, it, vi } from "vitest";
import { openRelay } from "@/modules/relay/dahuaRelay.service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dahua openRelay", () => {
  it("host yoki credential yetishmasa fetchsiz not_configured qaytaradi", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(openRelay({ host: null, username: "admin", password: "secret", channel: 1 })).resolves.toMatchObject({
      status: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Digest challenge'dan keyin authenticated CGI so'rovi yuboradi", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({
          "www-authenticate": 'Digest realm="Dahua", nonce="abc123", qop="auth", algorithm=MD5',
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await openRelay({
      host: "192.168.1.50",
      port: 80,
      username: "admin",
      password: "secret",
      channel: 2,
    });
    expect(result.status).toBe("opened");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://192.168.1.50/cgi-bin/accessControl.cgi?action=openDoor&channel=2&UserID=101&Type=Remote"
    );
    expect(fetchMock.mock.calls[1][1]?.headers.Authorization).toMatch(/^Digest /);
  });

  it("authentication rad etilsa failed qaytaradi", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ "www-authenticate": 'Digest realm="Dahua", nonce="abc123", qop="auth"' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      openRelay({ host: "192.168.1.50", username: "admin", password: "wrong", channel: 1 })
    ).resolves.toMatchObject({ status: "failed", detail: "Dahua relay login yoki parolni qabul qilmadi" });
  });

  it("tarmoq xatosida exception tashlamasdan failed qaytaradi", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    await expect(
      openRelay({ host: "192.168.1.50", username: "admin", password: "secret", channel: 1 })
    ).resolves.toMatchObject({ status: "failed" });
  });
});
