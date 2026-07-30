export interface NormalizedBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface BoundingBoxSizeLimits {
  minWidth: number;
  minHeight: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (key in obj) {
      return toFiniteNumber(obj[key]);
    }
  }
  return null;
}

function extractRawCoordinates(raw: unknown): [number, number, number, number] | null {
  if (Array.isArray(raw)) {
    if (raw.length !== 4) return null;
    const values = raw.map(toFiniteNumber);
    if (values.some((value) => value === null)) return null;
    return values as [number, number, number, number];
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const left = pickField(obj, ["Left", "left"]);
    const top = pickField(obj, ["Top", "top"]);
    const right = pickField(obj, ["Right", "right"]);
    const bottom = pickField(obj, ["Bottom", "bottom"]);
    if (left === null || top === null || right === null || bottom === null) return null;
    return [left, top, right, bottom];
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeBoundingBox(
  raw: unknown,
  imageWidth: number,
  imageHeight: number,
  limits: BoundingBoxSizeLimits
): NormalizedBoundingBox | null {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const coordinates = extractRawCoordinates(raw);
  if (!coordinates) return null;

  const left = clamp(Math.round(coordinates[0]), 0, imageWidth);
  const top = clamp(Math.round(coordinates[1]), 0, imageHeight);
  const right = clamp(Math.round(coordinates[2]), 0, imageWidth);
  const bottom = clamp(Math.round(coordinates[3]), 0, imageHeight);

  if (right <= left || bottom <= top) return null;

  const width = right - left;
  const height = bottom - top;
  if (width < limits.minWidth || height < limits.minHeight) return null;

  return { left, top, right, bottom, width, height };
}

export function padBoundingBox(
  box: NormalizedBoundingBox,
  imageWidth: number,
  imageHeight: number,
  paddingRatio: number
): NormalizedBoundingBox {
  const paddingX = Math.round(box.width * paddingRatio);
  const paddingY = Math.round(box.height * paddingRatio);
  const left = clamp(box.left - paddingX, 0, imageWidth);
  const top = clamp(box.top - paddingY, 0, imageHeight);
  const right = clamp(box.right + paddingX, 0, imageWidth);
  const bottom = clamp(box.bottom + paddingY, 0, imageHeight);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
