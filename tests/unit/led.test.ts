import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  led: {
    enabled: true,
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

vi.mock("@/config/db", () => ({
  db: vi.fn(),
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

const LED_ORG_ID = 1;
const ledConfigurations = new Map([
  [LED_ORG_ID, { orgId: LED_ORG_ID, host: "192.168.1.157", port: 10000 }],
]);

function createLedService(): LedService {
  return new LedService(
    async (orgId) => ledConfigurations.get(orgId) ?? null,
    async () => [...ledConfigurations.values()]
  );
}

async function flushLedOperation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.led.enabled = true;
  mocks.sendPackets.mockReset().mockResolvedValue(undefined);
  ledConfigurations.clear();
  ledConfigurations.set(LED_ORG_ID, {
    orgId: LED_ORG_ID,
    host: "192.168.1.157",
    port: 10000,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LED renderer, packets va service", () => {
  it("1. LED o'chirilganda TCP client chaqirilmaydi", async () => {
    mocks.led.enabled = false;
    const service = createLedService();
    await service.showClock(LED_ORG_ID);
    await service.showPayment(LED_ORG_ID, "75X963QG", 5000);
    await service.showPlateOnly(LED_ORG_ID, "75X963QG");
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.sendPackets).not.toHaveBeenCalled();
  });

  it("configured organization uchun DB'dagi host va portdan foydalanadi", async () => {
    const service = createLedService();

    await service.showClock(LED_ORG_ID);

    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
    expect(mocks.sendPackets.mock.calls[0]?.[1]).toEqual({
      host: "192.168.1.157",
      port: 10000,
    });
  });

  it("LED sozlanmagan organization uchun TCP va xato logisiz qaytadi", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = createLedService();

    await service.showPayment(2, "01A100AA", 5000);

    expect(mocks.sendPackets).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("showClock muvaffaqiyatli bo'lganda qisqa tasdiq logini yozadi", async () => {
    vi.setSystemTime(new Date("2026-08-21T09:23:00.000Z"));
    const service = createLedService();

    await service.showClock(LED_ORG_ID);

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("LED_CLOCK_SENT time=14:23");
  });

  it("showPlateOnly muvaffaqiyatli bo'lganda qisqa tasdiq logini yozadi", async () => {
    const service = createLedService();

    await service.showPlateOnly(LED_ORG_ID, "01 a123bc");

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("LED_PLATE_SENT plate=01A123BC");
  });

  it("showPayment muvaffaqiyatli bo'lganda qisqa tasdiq logini yozadi", async () => {
    const service = createLedService();

    await service.showPayment(LED_ORG_ID, "01 a123bc", 5000);

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("LED_PAYMENT_SENT plate=01A123BC amount=5000");
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
    const service = createLedService();
    await service.showPayment(LED_ORG_ID, "75X963QG", 5000);
    service.scheduleReturnToClock(LED_ORG_ID);
    await vi.advanceTimersByTimeAsync(1000);
    await service.showPayment(LED_ORG_ID, "01A123BC", 7000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    service.scheduleReturnToClock(LED_ORG_ID);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2001);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(3);
  });

  it("startup clockni darhol ko'rsatadi va keyin minut boundaryda yangilaydi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:47.250Z"));
    const sentAt: number[] = [];
    mocks.sendPackets.mockImplementation(async () => {
      sentAt.push(Date.now());
    });
    const service = createLedService();
    await service.showClockForConfiguredOrganizations();
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
    const service = createLedService();
    await service.showPayment(LED_ORG_ID, "75X963QG", 5000);
    service.scheduleReturnToClock(LED_ORG_ID);
    await vi.advanceTimersByTimeAsync(2999);
    expect(sentAt).toEqual([new Date("2026-08-19T09:23:47.000Z").getTime()]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt).toEqual([
      new Date("2026-08-19T09:23:47.000Z").getTime(),
      new Date("2026-08-19T09:23:50.000Z").getTime(),
    ]);
  });

  it("showPayment TCP tugagandan keyin ham return timerini boshlamaydi", async () => {
    let releaseFirstSend = (): void => undefined;
    mocks.sendPackets.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSend = resolve;
        })
    );
    const service = createLedService();
    const scheduleReturnToClock = vi.spyOn(service, "scheduleReturnToClock");
    const payment = service.showPayment(LED_ORG_ID, "01A100AA", 5000);
    await flushLedOperation();
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
    expect(scheduleReturnToClock).not.toHaveBeenCalled();
    releaseFirstSend();
    await payment;
    await vi.advanceTimersByTimeAsync(60000);
    expect(scheduleReturnToClock).not.toHaveBeenCalled();
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
  });

  it("payment TCP xatosidan keyin ham return timerini boshlamaydi", async () => {
    const error = new Error("connection refused");
    mocks.sendPackets.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = createLedService();
    const scheduleReturnToClock = vi.spyOn(service, "scheduleReturnToClock");
    await expect(service.showPayment(LED_ORG_ID, "01A100AA", 5000)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("LED_SEND_FAILED", error);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
    expect(scheduleReturnToClock).not.toHaveBeenCalled();
  });

  it("payment operator tasdigigacha schedulerda 120 soniya o'zgarmaydi", async () => {
    const service = createLedService();
    await service.showPayment(LED_ORG_ID, "01A100AA", 5000);
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
  });

  it("plate-only force-open'gacha schedulerda 120 soniya o'zgarmaydi", async () => {
    const service = createLedService();
    await service.showPlateOnly(LED_ORG_ID, "01A100AA");
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
  });

  it("yangi payment queue'dagi eski paymentni bekor qiladi", async () => {
    let releaseClock = (): void => undefined;
    mocks.sendPackets.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClock = resolve;
        })
    );
    const service = createLedService();
    const clock = service.showClock(LED_ORG_ID);
    await flushLedOperation();
    const firstPayment = service.showPayment(LED_ORG_ID, "01A100AA", 5000);
    const secondPayment = service.showPayment(LED_ORG_ID, "01B200BB", 7000);
    releaseClock();
    await Promise.all([clock, firstPayment, secondPayment]);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
  });

  it("return timer va scheduler yaqin vaqtda clockni ikki marta yubormaydi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:57.000Z"));
    const service = createLedService();
    await service.showPayment(LED_ORG_ID, "01A100AA", 5000);
    service.scheduleReturnToClock(LED_ORG_ID);
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
  });

  it("6. clock scheduler faqat clock holatida yuboradi", async () => {
    let releasePayment = (): void => undefined;
    const service = createLedService();
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(1);
    mocks.sendPackets.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePayment = resolve;
        })
    );
    const payment = service.showPayment(LED_ORG_ID, "75X963QG", 5000);
    await flushLedOperation();
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    releasePayment();
    await payment;
  });

  it("clock scheduler keyingi minut boshida va keyin har minut boshida ishlaydi", async () => {
    vi.setSystemTime(new Date("2026-08-19T09:23:47.250Z"));
    const sentAt: number[] = [];
    mocks.sendPackets.mockImplementation(async () => {
      sentAt.push(Date.now());
    });
    const service = createLedService();
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

  it("har bir organization clock va payment holatini alohida saqlaydi", async () => {
    ledConfigurations.set(2, { orgId: 2, host: "192.168.2.157", port: 10000 });
    const service = createLedService();

    await service.showPayment(LED_ORG_ID, "01A100AA", 5000);
    service.startClockScheduler();
    await vi.advanceTimersByTimeAsync(60000);

    expect(mocks.sendPackets).toHaveBeenCalledTimes(2);
    expect(mocks.sendPackets.mock.calls[0]?.[1]).toMatchObject({ host: "192.168.1.157" });
    expect(mocks.sendPackets.mock.calls[1]?.[1]).toMatchObject({ host: "192.168.2.157" });
  });

  it("7. TCP xatosi yuqoriga otilmaydi va log qilinadi", async () => {
    const error = new Error("connection refused");
    mocks.sendPackets.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = createLedService();
    await expect(service.showClock(LED_ORG_ID)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith("LED_SEND_FAILED", error);
  });

  it("8. o'n belgidan uzun plate birinchi o'n belgigacha kesiladi", async () => {
    const service = createLedService();
    await service.showPayment(LED_ORG_ID, "ABCDEFGHIJKL", 5000);
    const longPlatePackets = mocks.sendPackets.mock.calls[0][0] as Buffer[];
    mocks.sendPackets.mockClear();
    await service.showPayment(LED_ORG_ID, "ABCDEFGHIJ", 5000);
    const tenCharacterPackets = mocks.sendPackets.mock.calls[0][0] as Buffer[];
    expect(longPlatePackets).toEqual(tenCharacterPackets);
  });
});
