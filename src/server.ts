import http from "http";
import app from "./app";
import { db } from "./config/db";
import { env } from "./config/env";
import { scheduleBackupJob } from "./jobs/backupJob";
import { scheduleStorageCleanupJob } from "./jobs/storageCleanupJob";
import { scheduleUploadsBackupJob } from "./jobs/uploadsBackupJob";
import { shutdownAllStreams } from "./websocket/liveViewRelay";
import { initSocketServer } from "./websocket/socketServer";

process.on("uncaughtException", (error) => {
  console.error("KUTILMAGAN XATO:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("ISHLANMAGAN PROMISE XATOSI:", reason);
  process.exit(1);
});

const httpServer = http.createServer(app);
const io = initSocketServer(httpServer);
scheduleBackupJob();
scheduleUploadsBackupJob();
scheduleStorageCleanupJob();

httpServer.listen(env.port, () => {
  console.log(`Server running on port ${env.port} [${env.nodeEnv}]`);
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`${signal} qabul qilindi, server toza to'xtatilmoqda...`);

  shutdownAllStreams();

  const closeHttpServer = new Promise<void>((resolve) => {
    httpServer.close(() => {
      console.log("HTTP server yopildi");
      resolve();
    });
  });

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn(`${SHUTDOWN_TIMEOUT_MS}ms ichida yopilmadi — majburan davom etilmoqda`);
      resolve();
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });

  await Promise.race([closeHttpServer, timeout]);

  io.close();
  await db.destroy();
  console.log("DB ulanishlari yopildi");

  process.exit(0);
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch((err) => {
    console.error("Graceful shutdown paytida xato:", err);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch((err) => {
    console.error("Graceful shutdown paytida xato:", err);
    process.exit(1);
  });
});
