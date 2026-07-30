import { describe, expect, it } from "vitest";
import { normalizeBoundingBox, padBoundingBox } from "@/utils/boundingBox";

const IMAGE_WIDTH = 400;
const IMAGE_HEIGHT = 300;
const LIMITS = { minWidth: 20, minHeight: 20 };

describe("normalizeBoundingBox", () => {
  it("array formatini qo'llab-quvvatlaydi", () => {
    const box = normalizeBoundingBox([10, 20, 110, 120], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).toEqual({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 });
  });

  it("object formatini qo'llab-quvvatlaydi", () => {
    const box = normalizeBoundingBox({ Left: 10, Top: 20, Right: 110, Bottom: 120 }, IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).toEqual({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 });
  });

  it("kichik harfli object variantlarini qo'llab-quvvatlaydi", () => {
    const box = normalizeBoundingBox({ left: 10, top: 20, right: 110, bottom: 120 }, IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).toEqual({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 });
  });

  it("raqamli string koordinatalarni xavfsiz qo'llab-quvvatlaydi", () => {
    const box = normalizeBoundingBox(["10", "20", "110", "120"], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).toEqual({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 });
  });

  it("koordinatalarni rasm chegarasiga clamp qiladi", () => {
    const box = normalizeBoundingBox([-50, -50, 5000, 5000], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).toEqual({ left: 0, top: 0, right: IMAGE_WIDTH, bottom: IMAGE_HEIGHT, width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
  });

  it("manfiy koordinatalarni rad etmasdan clamp qiladi", () => {
    const box = normalizeBoundingBox([-10, -10, 100, 100], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box?.left).toBe(0);
    expect(box?.top).toBe(0);
  });

  it("[0,0,0,0] ni rad etadi", () => {
    expect(normalizeBoundingBox([0, 0, 0, 0], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
  });

  it("teskari (Right<=Left yoki Bottom<=Top) bbox'ni rad etadi", () => {
    expect(normalizeBoundingBox([100, 100, 50, 200], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
    expect(normalizeBoundingBox([100, 200, 200, 100], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
  });

  it("juda kichik bbox'ni minimal o'lchamdan pastda rad etadi", () => {
    expect(normalizeBoundingBox([10, 10, 15, 15], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
  });

  it("katta, lekin yaroqli vehicle bbox'ni faqat kattaligi uchun rad etmaydi", () => {
    const box = normalizeBoundingBox([0, 0, IMAGE_WIDTH, IMAGE_HEIGHT], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS);
    expect(box).not.toBeNull();
    expect(box?.width).toBe(IMAGE_WIDTH);
  });

  it("yaroqsiz shaklni (object/array emas) null qiladi", () => {
    expect(normalizeBoundingBox("not-a-box", IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
    expect(normalizeBoundingBox(undefined, IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
    expect(normalizeBoundingBox([1, 2, 3], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
  });

  it("moslashtirilmaydigan qiymatlarni null qiladi", () => {
    expect(normalizeBoundingBox(["a", "b", "c", "d"], IMAGE_WIDTH, IMAGE_HEIGHT, LIMITS)).toBeNull();
  });
});

describe("padBoundingBox", () => {
  it("padding qo'shadi va rasm chegarasidan chiqmaydi", () => {
    const box = { left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100 };
    const padded = padBoundingBox(box, IMAGE_WIDTH, IMAGE_HEIGHT, 0.05);
    expect(padded.left).toBeLessThan(box.left);
    expect(padded.top).toBeLessThan(box.top);
    expect(padded.right).toBeGreaterThan(box.right);
    expect(padded.bottom).toBeGreaterThan(box.bottom);
    expect(padded.left).toBeGreaterThanOrEqual(0);
    expect(padded.top).toBeGreaterThanOrEqual(0);
    expect(padded.right).toBeLessThanOrEqual(IMAGE_WIDTH);
    expect(padded.bottom).toBeLessThanOrEqual(IMAGE_HEIGHT);
  });

  it("chekka bbox uchun ham chegaradan chiqmaydi", () => {
    const box = { left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50 };
    const padded = padBoundingBox(box, IMAGE_WIDTH, IMAGE_HEIGHT, 0.5);
    expect(padded.left).toBeGreaterThanOrEqual(0);
    expect(padded.top).toBeGreaterThanOrEqual(0);
  });
});
