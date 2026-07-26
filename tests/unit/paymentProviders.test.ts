import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentProvider } from "@/modules/payment/paymentProvider.interface";
import { paymeProvider } from "@/modules/payment/providers/paymeProvider";
import { clickProvider } from "@/modules/payment/providers/clickProvider";

const providers: { name: string; provider: PaymentProvider }[] = [
  { name: "paymeProvider", provider: paymeProvider },
  { name: "clickProvider", provider: clickProvider },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(providers)("$name — PaymentProvider interfeysi", ({ provider }) => {
  it("createTransaction — 'Not implemented' xatosini tashlaydi", async () => {
    await expect(provider.createTransaction(1, 10000)).rejects.toThrow("Not implemented");
  });

  it("checkTransaction — 'Not implemented' xatosini tashlaydi", async () => {
    await expect(provider.checkTransaction("tx-1")).rejects.toThrow("Not implemented");
  });

  it("cancelTransaction — 'Not implemented' xatosini tashlaydi", async () => {
    await expect(provider.cancelTransaction("tx-1")).rejects.toThrow("Not implemented");
  });

  it("yoqilmagan holatda ogohlantirish logi yoziladi", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(provider.createTransaction(1, 10000)).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalled();
  });
});
