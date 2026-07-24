import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";

export function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "id noto'g'ri" });
    return null;
  }
  return id;
}

export function parseOptionalOrgIdFromQuery(req: Request, res: Response): number | undefined | null {
  if (req.query.org_id === undefined) return undefined;
  const orgId = Number(req.query.org_id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "org_id noto'g'ri" });
    return null;
  }
  return orgId;
}

export function parseOptionalOrgIdFromBody(req: Request, res: Response): number | undefined | null {
  if (req.body?.org_id === undefined) return undefined;
  const orgId = Number(req.body.org_id);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ message: "org_id noto'g'ri" });
    return null;
  }
  return orgId;
}

export function parsePaymentMethod(req: Request, res: Response): "cash" | "online" | null {
  const value = req.body?.payment_method;
  if (value === undefined) return "cash";
  if (value !== "cash" && value !== "online") {
    res.status(400).json({ message: "payment_method 'cash' yoki 'online' bo'lishi kerak" });
    return null;
  }
  return value;
}

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isValidImageBuffer(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) ||
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

export function resolveImageInput(req: Request): string | undefined {
  let buffer: Buffer;

  if (req.file) {
    buffer = req.file.buffer;
  } else if (req.body?.image) {
    buffer = Buffer.from(req.body.image, "base64");
  } else {
    return undefined;
  }

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new ApiError("Fayl hajmi juda katta", 400);
  }

  if (!isValidImageBuffer(buffer)) {
    throw new ApiError("Faqat JPEG/PNG rasm qabul qilinadi", 400);
  }

  return buffer.toString("base64");
}
