import { Request, Response } from "express";
import { db } from "@/config/db";

const DATABASE_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Database health check timeout")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createHealthHandler(databaseCheck: () => Promise<unknown> = () => Promise.resolve(db.raw("SELECT 1"))) {
  return async function healthHandler(req: Request, res: Response) {
    const timestamp = new Date().toISOString();
    try {
      await withTimeout(databaseCheck(), DATABASE_TIMEOUT_MS);
      res.status(200).json({ status: "ok", timestamp, database: "connected" });
    } catch {
      res.status(503).json({ status: "degraded", timestamp, database: "disconnected" });
    }
  };
}

export const healthHandler = createHealthHandler();
