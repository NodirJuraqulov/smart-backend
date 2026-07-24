import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import { operatorParkingRateLimit } from "@/middleware/parkingRateLimit";
import { upload } from "@/middleware/upload";
import { env } from "@/config/env";
import {
  activeHandler,
  capacityHandler,
  clearTestSessionsHandler,
  entryHandler,
  entryManualHandler,
  exitHandler,
  exitManualHandler,
  forceCloseHandler,
  sessionDetailHandler,
  sessionsHandler,
  updatePaymentMethodHandler,
} from "./parking.controller";

const router = Router();

router.use(isAuth);

router.post("/entry", operatorParkingRateLimit, upload.single("image"), asyncHandler(entryHandler));
router.post("/entry/manual", operatorParkingRateLimit, asyncHandler(entryManualHandler));
router.post("/exit", operatorParkingRateLimit, upload.single("image"), asyncHandler(exitHandler));
router.post("/exit/manual", operatorParkingRateLimit, asyncHandler(exitManualHandler));
router.get("/capacity", asyncHandler(capacityHandler));
router.get("/active", asyncHandler(activeHandler));
router.get("/sessions", asyncHandler(sessionsHandler));
router.get("/sessions/:id", asyncHandler(sessionDetailHandler));
router.post("/sessions/:id/force-close", asyncHandler(forceCloseHandler));
router.post("/sessions/:id/payment-method", asyncHandler(updatePaymentMethodHandler));

if (env.nodeEnv !== "production") {
  router.delete("/sessions/clear-test", isSuperAdmin, asyncHandler(clearTestSessionsHandler));
}

export default router;
