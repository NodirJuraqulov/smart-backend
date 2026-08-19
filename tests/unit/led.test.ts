import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  led: {
    enabled: true,
    host: "192.168.1.157",
    port: 10000,
    timeoutMs: 3000,
    clockIntervalMs: 60000,
    paymentConfirmDelayMs: 3000,
  },
  sendPackets: vi.fn(),
}));

vi.mock("@/config/env", () => ({
  env: {
    led: mocks.led,
    platformDefaultTimezone: "Asia/Tashkent",
  },
}));

vi.mock("@/modules/led/led.client", () => ({
  LedClientError: class LedClientError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  sendPackets: mocks.sendPackets,
}));

import { LedService } from "@/modules/led/led.service";
import {
  ITEM_TEMPLATE,
  PREFIX,
  buildLogicalPayload,
  buildPackets,
} from "@/modules/led/led.packetBuilder";
import {
  pixelsToPlane1,
  renderClock,
  renderPayment,
  renderPlateOnly,
} from "@/modules/led/led.renderer";

const PAYMENT_GOLDEN_HEX =
  "ffffffffffffffffffffffffffffffffff20e882201c87ffff20e882201c87ffffafefbafeebfaffffafefbafeebfaffffaf5fbbfeebfaffffaf5fbbfeebfaffffb75fbbfeebfaffffb75fbbfeebfaffff37bc8360ec8affff37bc8360ec8afffffb5bbfeeabbafffffb5bbfeeabbafffffb5bbfee6bbbfffffb5bbfee6bbbfffffdebbeeeebbafffffdebbeeeebbaffff3decc2209c86ffff3decc2209c86ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0f8220f8ffffffff0f8220f8ffffffffefbbaefbffffffffefbbaefbffffffffefbbaefbffffffffefbbaefbffffffffefbbaefbffffffffefbbaefbffffffff0fbbaefbffffffff0fbbaefbffffffffffbaaefbffffffffffbaaefbffffffffffbaaefbffffffffffbaaefbffffffffffbaaefbffffffffffbaaefbffffffff0f8320f8ffffffff0f8320f8ffffffffffffffffffffffffffffffffffff";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.led.enabled = true;
  mocks.sendPackets.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LED renderer, packets va service", () => {
  it("1. LED o'chirilganda TCP client chaqirilmaydi", async () => {
    mocks.led.enabled = false;
    const service = new LedService();
    await service.showClock();
    await service.showPayment("75X963QG", 5000);
    await service.showPlateOnly("75X963QG");
    service.scheduleReturnToClock();
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.sendPackets).not.toHaveBeenCalled();
  });

  it("2. payment bitmap tasdiqlangan font va mappingga mos", () => {
    const plane = pixelsToPlane1(renderPayment("75X963QG", "5000"));
    expect(plane).toHaveLength(352);
    expect(plane.toString("hex")).toBe(PAYMENT_GOLDEN_HEX);
  });

  it("3. clock gorizontal va vertikal markazda render qilinadi", () => {
    const pixels = renderClock("07:42");
    expect(pixels[13][17]).toBe(1);
    expect(pixels[15][31]).toBe(1);
    expect(pixels[12].every((pixel) => pixel === 0)).toBe(true);
    expect(pixels[31].every((pixel) => pixel === 0)).toBe(true);
    expect(pixels.every((row) => row[16] === 0 && row[46] === 0)).toBe(true);
  });

  it("plate-only faqat bitta markazlangan qatorni render qiladi", () => {
    const pixels = renderPlateOnly("75X963QG");
    expect(pixels).toEqual(renderClock("75X963QG"));
    expect(pixels.slice(0, 13).every((row) => row.every((pixel) => pixel === 0))).toBe(true);
    expect(pixels.slice(31).every((row) => row.every((pixel) => pixel === 0))).toBe(true);
  });

  it("4. logical uzunlik va 512 baytli packet headerlari to'g'ri", () => {
    expect(PREFIX).toHaveLength(25);
    expect(ITEM_TEMPLATE).toHaveLength(24);
    expect(ITEM_TEMPLATE.readUInt32LE(1)).toBe(760);
    expect(PREFIX.length + ITEM_TEMPLATE.readUInt32LE(1)).toBe(785);
    const logicalPayload = buildLogicalPayload(Buffer.alloc(352, 0xff));
    expect(logicalPayload).toHaveLength(1457);
    expect(logicalPayload.readUInt32LE(2)).toBe(1456);
    expect(logicalPayload.subarray(2, 6).toString("hex")).toBe("b0050000");
    expect(PREFIX.readUInt32LE(2)).toBe(784);
    expect(logicalPayload.readUInt32LE(26)).toBe(1432);
    expect(logicalPayload.readUInt16LE(33)).toBe(10);
    expect(logicalPayload.readUInt16LE(35)).toBe(63);
    expect(logicalPayload.readUInt16LE(37)).toBe(53);
    const oldPackets = buildPackets(Buffer.alloc(785, 0x5a));
    expect(oldPackets).toHaveLength(2);
    expect(oldPackets.every((packet) => packet.length === 536)).toBe(true);
    expect(oldPackets.map((packet) => packet.readUInt16LE(8))).toEqual([0, 1]);
    expect(oldPackets.map((packet) => packet.readUInt32LE(10))).toEqual([785, 785]);
    expect(oldPackets.map((packet) => packet.readUInt32LE(16))).toEqual([512, 273]);
    expect(oldPackets[0].subarray(0, 8).toString("hex")).toBe("55aa0000010000da");
    expect(oldPackets[0].subarray(532, 536).toString("hex")).toBe("00000d0a");
    expect(oldPackets[1].subarray(293, 297).toString("hex")).toBe("00000d0a");
    const packetsFor1072 = buildPackets(Buffer.alloc(1072));
    expect(packetsFor1072).toHaveLength(3);
    expect(packetsFor1072.map((packet) => packet.readUInt32LE(16))).toEqual([512, 512, 48]);
  });

  it.each([184, 352, 512])("plane hajmi %i bo'lganda prefix va item uzunligi dinamik yoziladi", (planeSize) => {
    const logicalPayload = buildLogicalPayload(Buffer.alloc(planeSize, 0xff));
    expect(logicalPayload).toHaveLength(PREFIX.length + ITEM_TEMPLATE.length + planeSize * 4);
    expect(logicalPayload.readUInt32LE(2)).toBe(logicalPayload.length - 1);
    expect(logicalPayload.readUInt32LE(PREFIX.length + 1)).toBe(ITEM_TEMPLATE.length + planeSize * 4);
  });

  it("5. yangi payment oldingi clock qaytarish timerini bekor qiladi", async () => {
    const service = new LedService();
    await service.showPayment("75X963QG", 5000);
    service.scheduleReturnToClock();
    await vi.advanceTimersByTimeAsync(1000);
    await service.showPayment("01A123BC", 7000);
    service.scheduleReturnToClock();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(3);
  });

  it("startup clockni darhol ko'rsatadi va keyin minut boundaryda yangilaydi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:47.250Z"));
    const sentAt: number[] = [];
    mocks.sendPackets.mockImplementation(async () => {
      sentAt.push(Date.now());
    });
    const service = new LedService();
    await service.showClock();
    service.startClockScheduler();
    expect(sentAt).toEqual([new Date("2026-08-19T09:23:47.250Z").getTime()]);
    await vi.advanceTimersByTimeAsync(12750);
    expect(sentAt).toEqual([
      new Date("2026-08-19T09:23:47.250Z").getTime(),
      new Date("2026-08-19T09:24:00.000Z").getTime(),
    ]);
  });

  it("paymentdan uch soniya keyin scheduler kutmasdan clockni ko'rsatadi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:47.000Z"));
    const sentAt: number[] = [];
    mocks.sendPackets.mockImplementation(async () => {
      sentAt.push(Date.now());
    });
    const service = new LedService();
    await service.showPayment("75X963QG", 5000);
    service.scheduleReturnToClock();
    await vi.advanceTimersByTimeAsync(2999);
    expect(sentAt).toEqual([new Date("2026-08-19T09:23:47.000Z").getTime()]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt).toEqual([
      new Date("2026-08-19T09:23:47.000Z").getTime(),
      new Date("2026-08-19T09:23:50.000Z").getTime(),
    ]);
  });

  it("queue'dagi stale clock yangi paymentdan keyin yuborilmaydi", async () => {
    let releaseFirstSend = (): void => undefined;
    mocks.sendPackets.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSend = resolve;
        })
    );
    const service = new LedService();
    const firstPayment = service.showPayment("01A100AA", 5000);
    service.scheduleReturnToClock();
    await vi.advanceTimersByTimeAsync(3000);
    const secondPayment = service.showPayment("01B200BB", 7000);
    releaseFirstSend();
    await Promise.all([firstPayment, secondPayment]);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
  });

  it("clock va payment transition markerlarini yozadi", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const service = new LedService();
    await service.showPayment("01A100AA", 5000);
    service.scheduleReturnToClock();
    await service.showPayment("01B200BB", 7000);
    service.scheduleReturnToClock();
    await vi.advanceTimersByTimeAsync(3000);
    const markers = consoleLog.mock.calls.map((call) => call[0]);
    expect(markers).toEqual(
      expect.arrayContaining([
        "PAYMENT_MODE_ENTERED",
        "RETURN_TO_CLOCK_TIMER_STARTED",
        "RETURN_TO_CLOCK_TIMER_CANCELLED",
        "RETURN_TO_CLOCK_TIMER_FIRED",
        "CLOCK_MODE_ENTERED",
        "CLOCK_IMMEDIATE_SHOW_START",
        "CLOCK_IMMEDIATE_SHOW_FINISHED",
      ])
    );
  });

  it("6. clock scheduler faqat clock holatida yuboradi", async () => {
    const service = new LedService();
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
    await service.showPayment("75X963QG", 5000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
  });

  it("clock scheduler keyingi minut boshida va keyin har minut boshida ishlaydi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:47.250Z"));
    const sentAt: number[] = [];
    mocks.sendPackets.mockImplementation(async () => {
      sentAt.push(Date.now());
    });
    const service = new LedService();
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(12749);
    expect(sentAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt).toEqual([new Date("2026-08-19T09:24:00.000Z").getTime()]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sentAt).toEqual([
      new Date("2026-08-19T09:24:00.000Z").getTime(),
      new Date("2026-08-19T09:25:00.000Z").getTime(),
    ]);
  });

  it("7. TCP xatosi yuqoriga otilmaydi va log qilinadi", async () => {
    const error = new Error("connection refused");
    mocks.sendPackets.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new LedService();
    await expect(service.showClock()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("LED_SEND_FAILED", error);
  });

  it("8. o'n belgidan uzun plate birinchi o'n belgigacha kesiladi", async () => {
    const service = new LedService();
    await service.showPayment("ABCDEFGHIJKL", 5000);
    const longPlatePackets = mocks.sendPackets.mock.calls[0][0] as Buffer[];
    mocks.sendPackets.mockClear();
    await service.showPayment("ABCDEFGHIJ", 5000);
    const tenCharacterPackets = mocks.sendPackets.mock.calls[0][0] as Buffer[];
    expect(longPlatePackets).toEqual(tenCharacterPackets);
  });
});
