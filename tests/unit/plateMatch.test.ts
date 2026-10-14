import { describe, expect, it } from "vitest";
import {
  canonicalizePlate,
  plateDistance,
  similarityPercent,
} from "@/modules/exitCandidates/plateMatch";

describe("plateMatch", () => {
  it("plate belgilarini canonical ko'rinishga o'tkazadi", () => {
    expect(canonicalizePlate(" 01o iB-s ")).toBe("010185");
    expect(canonicalizePlate("ab.c-12_3")).toBe("A8C123");
  });

  it.each([
    ["01A123BC", "01A123B", 1],
    ["01A123BC", "01A123BXC", 1],
    ["01A123BC", "01A123BD", 1],
    ["AB", "BA", 2],
    ["01O123BI", "01012381", 0],
  ])("%s va %s orasidagi Levenshtein masofasini %i qaytaradi", (left, right, expected) => {
    expect(plateDistance(left, right)).toBe(expected);
  });

  it("o'xshashlikni butun foizda qaytaradi", () => {
    expect(similarityPercent("01A123BC", "01A123BD")).toBe(88);
    expect(similarityPercent("01O123BI", "01012381")).toBe(100);
    expect(similarityPercent("", "")).toBe(100);
  });
});
