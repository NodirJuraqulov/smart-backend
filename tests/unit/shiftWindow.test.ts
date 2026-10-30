import { describe, expect, it } from "vitest";
import { getOrganizationShiftWindow } from "@/utils/shiftWindow";

describe("getOrganizationShiftWindow", () => {
  it("Asia/Tashkent smenasini mahalliy 08:00 dan keyingi 08:00 gacha quradi", () => {
    const window = getOrganizationShiftWindow("2026-10-30", "Asia/Tashkent");

    expect(window.date).toBe("2026-10-30");
    expect(window.from.toISOString()).toBe("2026-10-30T03:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-10-31T03:00:00.000Z");
    expect(new Date("2026-10-30T02:59:59.999Z").getTime()).toBeLessThan(window.from.getTime());
    expect(new Date("2026-10-30T03:00:00.000Z").getTime()).toBe(window.from.getTime());
  });

  it("America/New_York smenasini tashkilot zonasidagi 08:00 chegarasi bilan quradi", () => {
    const window = getOrganizationShiftWindow("2026-10-30", "America/New_York");

    expect(window.from.toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(new Date("2026-10-31T11:59:59.999Z").getTime()).toBeLessThan(window.to.getTime());
    expect(new Date("2026-10-31T12:00:00.000Z").getTime()).toBe(window.to.getTime());
  });
});
