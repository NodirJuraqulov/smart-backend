import { LED_FONT } from "./led.font";

export const W = 64;
export const H = 44;
export const Y_START = 10;
export const SX = 1;
export const SY = 2;
export const CHAR_W = 5;
export const CHAR_H = 18;
export const GAP_X = 1;
export const GAP_Y = 4;

export type LedPixels = number[][];

export function createPixels(): LedPixels {
  return Array.from({ length: H }, () => Array<number>(W).fill(0));
}

export function renderText(text: string, y: number, pixels: LedPixels): void {
  const normalized = text.toUpperCase().replace(/ /g, "");
  if (!normalized) return;
  const totalWidth = normalized.length * CHAR_W + (normalized.length - 1) * GAP_X;
  let x = Math.floor((W - totalWidth) / 2);
  for (const character of normalized) {
    const glyph = LED_FONT[character] ?? LED_FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let repeatY = 0; repeatY < SY; repeatY += 1) {
        const pixelY = y + row * SY + repeatY;
        for (let column = 0; column < glyph[row].length; column += 1) {
          if (glyph[row][column] !== "1") continue;
          for (let repeatX = 0; repeatX < SX; repeatX += 1) {
            const pixelX = x + column * SX + repeatX;
            if (pixelY >= 0 && pixelY < H && pixelX >= 0 && pixelX < W) {
              pixels[pixelY][pixelX] = 1;
            }
          }
        }
      }
    }
    x += CHAR_W + GAP_X;
  }
}

export function renderPayment(plate: string, amount: string): LedPixels {
  const pixels = createPixels();
  const totalHeight = CHAR_H * 2 + GAP_Y;
  const top = Math.floor((H - totalHeight) / 2);
  renderText(plate, top, pixels);
  renderText(amount, top + CHAR_H + GAP_Y, pixels);
  return pixels;
}

export function renderClock(time: string): LedPixels {
  const pixels = createPixels();
  const y = Math.floor((H - CHAR_H) / 2);
  renderText(time, y, pixels);
  return pixels;
}

export function pixelsToPlane1(pixels: LedPixels): Buffer {
  const plane1 = Buffer.alloc(352, 0xff);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!pixels[y]?.[x]) continue;
      const position = y * 8 + Math.floor(x / 8);
      const bit = x % 8;
      plane1[position] &= ~(1 << bit);
    }
  }
  return plane1;
}
