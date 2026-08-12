import { describe, expect, it } from "vitest";
import { isValidPlateFormat, PlateFormat } from "@/modules/plateFormats/plateFormats.service";

function format(pattern: string, isActive = true): PlateFormat {
  return {
    id: Math.floor(Math.random() * 100000),
    org_id: 1,
    pattern,
    description: null,
    is_active: isActive,
    created_at: new Date(),
  };
}

describe("isValidPlateFormat", () => {
  const formats = [format("NNLNNNLL"), format("NNNNNLLL"), format("LLLNNN")];

  it.each([
    ["01A123BC", true],
    ["01 123 ABC", true],
    ["PAA265", true],
    ["01-a-123-bc", true],
    ["01A12XBC", false],
    ["0AA123BC", false],
    ["01123AB1", false],
    ["PAA26X", false],
    ["", false],
    [" ", false],
    ["01A12BC", false],
    ["01A1234BC", false],
    ["01А123ВС", false],
    ["12345678", false],
  ])("%j qiymatini to'g'ri tekshiradi", (plate, expected) => {
    expect(isValidPlateFormat(plate, formats)).toBe(expected);
  });

  it("aktiv format bo'lmasa bloklamaydi", () => {
    expect(isValidPlateFormat("", [])).toBe(true);
    expect(isValidPlateFormat("NOT-A-PLATE", [format("NNLNNNLL", false)])).toBe(true);
  });

  it("kamida bitta aktiv format mos kelsa true qaytaradi", () => {
    expect(
      isValidPlateFormat("01A123BC", [format("LLLNNN"), format("NNLNNNLL")])
    ).toBe(true);
  });
});
