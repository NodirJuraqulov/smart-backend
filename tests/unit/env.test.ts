import { describe, expect, it } from "vitest";
import { collectProductionSafetyErrors, stripTrailingSlashes } from "@/config/env";

const validConfig = {
  jwtSecret: "a".repeat(40),
  corsOrigin: "https://app.stoyanka.uz",
  dbPassword: "Kuchli-Tasodifiy-Parol-2026",
  publicBaseUrl: "http://195.158.9.168:84",
};

describe("stripTrailingSlashes", () => {
  it("bitta oxirgi / ni olib tashlaydi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84/")).toBe("http://195.158.9.168:84");
  });

  it("bir nechta ketma-ket / larni ham olib tashlaydi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84///")).toBe("http://195.158.9.168:84");
  });

  it("/ bo'lmasa o'zgarishsiz qoldiradi", () => {
    expect(stripTrailingSlashes("http://195.158.9.168:84")).toBe("http://195.158.9.168:84");
  });
});

describe("collectProductionSafetyErrors — PUBLIC_BASE_URL", () => {
  it("to'g'ri konfiguratsiyada xato qaytarmaydi", () => {
    expect(collectProductionSafetyErrors(validConfig)).toEqual([]);
  });

  it("PUBLIC_BASE_URL belgilanmagan bo'lsa — tushunarli xato qaytaradi", () => {
    const errors = collectProductionSafetyErrors({ ...validConfig, publicBaseUrl: undefined });
    expect(errors).toContain(
      "PUBLIC_BASE_URL belgilanmagan — webhook URL generatsiyasi uchun majburiy (masalan http://195.158.9.168:84)"
    );
  });

  it("PUBLIC_BASE_URL noto'g'ri formatda bo'lsa — tushunarli xato qaytaradi", () => {
    const errors = collectProductionSafetyErrors({ ...validConfig, publicBaseUrl: "not-a-valid-url" });
    expect(errors).toContain(`PUBLIC_BASE_URL noto'g'ri URL formatida: "not-a-valid-url"`);
  });

  it("boshqa xatolar bilan bir qatorda mustaqil qayd etiladi", () => {
    const errors = collectProductionSafetyErrors({
      jwtSecret: "short",
      corsOrigin: "*",
      dbPassword: "",
      publicBaseUrl: undefined,
    });
    expect(errors).toHaveLength(4);
  });
});
