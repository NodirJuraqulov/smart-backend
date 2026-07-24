import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ApiError } from "@/utils/ApiError";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ message: err.message, ...err.details });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ message: "Fayl hajmi juda katta" });
      return;
    }
    res.status(400).json({ message: "Fayl yuklashda xatolik" });
    return;
  }

  const rawStatus = (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;

  if (typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 500) {
    res.status(rawStatus).json({ message: err.message || "Noto'g'ri so'rov" });
    return;
  }

  console.error(err);
  res.status(500).json({ message: "Internal server error" });
}
