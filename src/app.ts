import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { generalApiRateLimit } from "./middleware/generalRateLimit";
import { healthHandler } from "./modules/health/health.controller";
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
import exitCandidatesRouter from "./modules/exitCandidates/exitCandidates.routes";
import cameraRelaySettingsRouter from "./modules/organizations/cameraRelaySettings.routes";
import entryCandidatesRouter from "./modules/entryCandidates/entryCandidates.routes";
import parkingSessionsEntryBarrierRouter from "./modules/entryCandidates/parkingSessionsEntryBarrier.routes";

const app = express();

app.set("trust proxy", "loopback");
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

app.get("/health", healthHandler);

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
app.use("/api/organizations", cameraRelaySettingsRouter);
app.use("/api/admin/stats", adminStatsRouter);
app.use("/api/admin/users", usersRouter);
app.use("/api/tariffs", tariffsRouter);
app.use("/api/tariff-intervals", tariffIntervalsSelfRouter);
app.use("/api/subscription-plans", subscriptionPlansRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/vip-vehicles", vipVehiclesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/webhook-events", webhookEventsRouter);
app.use("/api/exit-candidates", exitCandidatesRouter);
app.use("/api/entry-candidates", entryCandidatesRouter);
app.use("/api/parking-sessions", parkingSessionsEntryBarrierRouter);
app.use("/api/parking", parkingRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/admin/activity-logs", activityLogsRouter);
app.use("/api/public/display", publicDisplayRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
