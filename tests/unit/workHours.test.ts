import { describe, expect, it } from "vitest";
import { isWithinWorkHours, timeStringToMinutes } from "@/modules/parking/parking.service";

describe("timeStringToMinutes", () => {
  it("HH:MM ni kun boshidan boshlab minutlarga o'giradi", () => {
    expect(timeStringToMinutes("00:00")).toBe(0);
    expect(timeStringToMinutes("09:30")).toBe(570);
    expect(timeStringToMinutes("23:59")).toBe(1439);
  });
});

describe("isWithinWorkHours", () => {
  it("ish vaqti ichida — ruxsat (oddiy oraliq)", () => {
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("12:00"))).toBe(true);
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("09:00"))).toBe(true);
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("18:00"))).toBe(true);
  });

  it("ish vaqti tashqarisida — rad etiladi (oddiy oraliq)", () => {
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("08:59"))).toBe(false);
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("18:01"))).toBe(false);
    expect(isWithinWorkHours("09:00", "18:00", timeStringToMinutes("23:30"))).toBe(false);
  });

  it("tungi (kesib o'tuvchi) oraliqda to'g'ri hisoblaydi — ichida", () => {
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("23:30"))).toBe(true);
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("02:00"))).toBe(true);
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("22:00"))).toBe(true);
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("06:00"))).toBe(true);
  });

  it("tungi (kesib o'tuvchi) oraliqda to'g'ri hisoblaydi — tashqarisida", () => {
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("12:00"))).toBe(false);
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("06:01"))).toBe(false);
    expect(isWithinWorkHours("22:00", "06:00", timeStringToMinutes("21:59"))).toBe(false);
  });
});
