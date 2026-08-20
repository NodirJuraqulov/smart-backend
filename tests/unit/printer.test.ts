import { afterEach, describe, expect, it, vi } from "vitest";

const { executeMock, printerConstructorMock } = vi.hoisted(() => {
  const executeMock = vi.fn();
  function printerConstructorMock() {
    return {
      alignCenter: vi.fn(),
      alignLeft: vi.fn(),
      setTextDoubleHeight: vi.fn(),
      setTextNormal: vi.fn(),
      bold: vi.fn(),
      println: vi.fn(),
      drawLine: vi.fn(),
      newLine: vi.fn(),
      cut: vi.fn(),
      execute: executeMock,
    };
  }
  return { executeMock, printerConstructorMock: vi.fn(printerConstructorMock) };
});

vi.mock("node-thermal-printer", () => ({
  printer: printerConstructorMock,
  types: { EPSON: "epson" },
}));

import { printReceipt } from "@/modules/printer/printer.service";

const receiptData = {
  orgName: "Test Stoyanka",
  plateNumber: "01A123AA",
  enteredAt: new Date("2026-07-25T08:00:00Z"),
  exitedAt: new Date("2026-07-25T09:00:00Z"),
  durationMinutes: 60,
  amount: 5000,
  paymentMethod: "cash" as const,
  issuedAt: new Date("2026-07-25T09:00:05Z"),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("printReceipt", () => {
  it("printerIp bo'sh bo'lsa — ulanmasdan false qaytaradi", async () => {
    const result = await printReceipt(null, receiptData);

    expect(result).toBe(false);
    expect(printerConstructorMock).not.toHaveBeenCalled();
  });

  it("muvaffaqiyatli chop etishda true qaytaradi", async () => {
    executeMock.mockResolvedValue("");

    const result = await printReceipt("192.168.1.60", receiptData);

    expect(result).toBe(true);
    expect(printerConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ interface: "tcp://192.168.1.60:9100" })
    );
  });

  it("xato/timeout holatida exception tashlamasdan false qaytaradi", async () => {
    executeMock.mockRejectedValue(new Error("Socket timeout"));

    const result = await printReceipt("192.168.1.60", receiptData);

    expect(result).toBe(false);
  });
});
