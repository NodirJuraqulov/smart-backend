import { describe, expect, it } from "vitest";
import { calculateAmount, calculateIntervalAmount } from "@/modules/parking/parking.service";

const intervals = [
  { from_minutes: 5, to_minutes: 60, price: 10000 },
  { from_minutes: 61, to_minutes: 600, price: 30000 },
  { from_minutes: 601, to_minutes: null, price: 50000 },
];

describe("calculateIntervalAmount", () => {
  it("birinchi interval'dan oldin (4 daqiqa) — amount 0", () => {
    expect(calculateIntervalAmount(4, intervals)).toBe(0);
  });

  it("birinchi interval ichida (7 daqiqa) — birinchi interval narxi", () => {
    expect(calculateIntervalAmount(7, intervals)).toBe(10000);
  });

  it("ikkinchi interval ichida (65 daqiqa) — ikkinchi interval narxi", () => {
    expect(calculateIntervalAmount(65, intervals)).toBe(30000);
  });

  it("cheksiz oxirgi interval (to_minutes: null) — 10 soatdan ko'p tursa ham bir xil narx", () => {
    expect(calculateIntervalAmount(700, intervals)).toBe(50000);
    expect(calculateIntervalAmount(100000, intervals)).toBe(50000);
  });

  it("flat narx — davomiylik oshsa ham interval ichida narx o'zgarmaydi", () => {
    expect(calculateIntervalAmount(60, intervals)).toBe(10000);
    expect(calculateIntervalAmount(600, intervals)).toBe(30000);
  });

  it("intervallar bo'sh bo'lsa — amount 0", () => {
    expect(calculateIntervalAmount(100, [])).toBe(0);
  });
});

describe("calculateAmount — interval rejimi bilan kengaytirilgan", () => {
  it("intervals berilganda flat narx qaytariladi, hourly parametrlar e'tiborga olinmaydi", () => {
    expect(calculateAmount(7, 5000, 0, intervals)).toBe(10000);
    expect(calculateAmount(65, 999999, 999, intervals)).toBe(30000);
  });

  it("intervals berilmasa yoki bo'sh bo'lsa — hozirgidek hourly mantiq ishlaydi", () => {
    expect(calculateAmount(120, 5000, 0)).toBe(10000);
    expect(calculateAmount(120, 5000, 0, [])).toBe(10000);
    expect(calculateAmount(120, 5000, 0, null)).toBe(10000);
  });
});
