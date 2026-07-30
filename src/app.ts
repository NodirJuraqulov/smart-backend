import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { db } from "./config/db";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { generalApiRateLimit } from "./middleware/generalRateLimit";
import authRouter from "./modules/auth/auth.routes";
import organizationsRouter, { adminStatsRouter } from "./modules/organizations/organizations.routes";
import usersRouter from "./modules/users/users.routes";
import tariffsRouter from "./modules/tariffs/tariffs.routes";
import tariffIntervalsSelfRouter from "./modules/tariffIntervals/tariffIntervalsSelf.routes";
import subscriptionPlansRouter from "./modules/subscriptionPlans/subscriptionPlans.routes";
import subscriptionsRouter from "./modules/subscriptions/subscriptions.routes";
import vipVehiclesRouter from "./modules/vipVehicles/vipVehicles.routes";
import settingsRouter from "./modules/settings/settings.routes";
import parkingRouter from "./modules/parking/parking.routes";
import reportsRouter from "./modules/reports/reports.routes";
import activityLogsRouter from "./modules/activityLogs/activityLogs.routes";
import webhookRouter from "./modules/webhook/webhook.routes";
import publicDisplayRouter from "./modules/publicDisplay/publicDisplay.routes";
import paymentRouter from "./modules/payment/payment.routes";
import webhookEventsRouter from "./modules/webhook/webhookEvents.routes";

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "http:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);
app.use(cors({ origin: env.corsOrigin }));
app.use("/api/webhook", webhookRouter);
app.use("/api/payments", paymentRouter);
app.use(express.json({ limit: "10mb" }));
app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

const HEALTH_CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

app.get("/health", async (req, res) => {
  const pool = (db.client as unknown as { pool: Record<string, unknown> }).pool as {
    min: number;
    max: number;
    numUsed: () => number;
    numFree: () => number;
    numPendingAcquires: () => number;
  };
  const poolStats = {
    min: pool.min,
    max: pool.max,
    used: pool.numUsed(),
    free: pool.numFree(),
    pending_acquires: pool.numPendingAcquires(),
  };

  try {
    await withTimeout(db.raw("SELECT 1"), HEALTH_CHECK_TIMEOUT_MS, "DB javob berish vaqti tugadi (2s)");
    res.json({ status: "ok", database: "connected", pool: poolStats });
  } catch (err) {
    res.status(503).json({
      status: "error",
      database: "disconnected",
      message: err instanceof Error ? err.message : "DB ulanishida noma'lum xato",
      pool: poolStats,
    });
  }
});

if (env.nodeEnv !== "production") {
  app.get("/api/dev/crash-test", (req, res) => {
    res.json({ message: "Uncaught exception 100ms dan keyin sodir bo'ladi" });
    setTimeout(() => {
      throw new Error("Sun'iy test xatosi (crash-test endpoint)");
    }, 100);
  });
}

app.use("/uploads/parking", (_req, res) => {
  res.status(404).json({ message: "Rasm topilmadi" });
});
app.use("/uploads/parking-events", (_req, res) => {
  res.status(404).json({ message: "Rasm topilmadi" });
});

app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(path.join(__dirname, "..", "uploads"))
);

app.use("/api", generalApiRateLimit);

app.use("/api/auth", authRouter);
app.use("/api/admin/organizations", organizationsRouter);
app.use("/api/admin/stats", adminStatsRouter);
app.use("/api/admin/users", usersRouter);
app.use("/api/tariffs", tariffsRouter);
app.use("/api/tariff-intervals", tariffIntervalsSelfRouter);
app.use("/api/subscription-plans", subscriptionPlansRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/vip-vehicles", vipVehiclesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/webhook-events", webhookEventsRouter);
app.use("/api/parking", parkingRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/admin/activity-logs", activityLogsRouter);
app.use("/api/public/display", publicDisplayRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
