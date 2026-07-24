import { describe, expect, it } from "vitest";
import { calculateAmount, calculateDurationMinutes } from "@/modules/parking/parking.service";

describe("calculateDurationMinutes", () => {
  it("hisoblaydi oddiy davomiylikni minutlarda", () => {
    const enteredAt = new Date("2026-01-01T10:00:00Z");
    const exitedAt = new Date("2026-01-01T12:00:00Z");
    expect(calculateDurationMinutes(enteredAt, exitedAt)).toBe(120);
  });

  it("manfiy davomiylik (soat sinxronizatsiyasi buzilganda) uchun 0 qaytaradi, xato tashlamaydi", () => {
    const enteredAt = new Date("2026-01-01T12:00:00Z");
    const exitedAt = new Date("2026-01-01T10:00:00Z");
    expect(() => calculateDurationMinutes(enteredAt, exitedAt)).not.toThrow();
    expect(calculateDurationMinutes(enteredAt, exitedAt)).toBe(0);
  });

  it("to'liq bo'lmagan daqiqani yuqoriga yaxlitlaydi", () => {
    const enteredAt = new Date("2026-01-01T10:00:00Z");
    const exitedAt = new Date("2026-01-01T10:00:30Z");
    expect(calculateDurationMinutes(enteredAt, exitedAt)).toBe(1);
  });
});

describe("calculateAmount", () => {
  it("oddiy hisoblash: 2 soat, 5000/soat = 10000", () => {
    expect(calculateAmount(120, 5000, 0)).toBe(10000);
  });

  it("grace period ichida — amount 0", () => {
    expect(calculateAmount(10, 5000, 15)).toBe(0);
  });

  it("grace period chegarasida (teng) — amount 0", () => {
    expect(calculateAmount(15, 5000, 15)).toBe(0);
  });

  it("grace period tashqarisida — to'liq hisoblanadi (boshlangan soat yuqoriga yaxlitlanadi)", () => {
    expect(calculateAmount(16, 5000, 15)).toBe(5000);
    expect(calculateAmount(90, 5000, 15)).toBe(10000);
  });

  it("manfiy davomiylikdan kelgan duration=0 uchun amount 0 qaytaradi", () => {
    expect(calculateAmount(0, 5000, 0)).toBe(0);
  });

  it("kirish paytida muzlatilgan tarif narxi ishlatiladi — joriy (o'zgargan) narx e'tiborga olinmaydi", () => {
    const frozenPricePerHour = 5000;
    const currentDifferentPricePerHour = 8000;

    const amountWithFrozenPrice = calculateAmount(120, frozenPricePerHour, 0);
    const amountIfCurrentPriceWereUsed = calculateAmount(120, currentDifferentPricePerHour, 0);

    expect(amountWithFrozenPrice).toBe(10000);
    expect(amountWithFrozenPrice).not.toBe(amountIfCurrentPriceWereUsed);
  });
});
