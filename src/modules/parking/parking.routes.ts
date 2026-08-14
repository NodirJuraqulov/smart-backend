import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isOperatorOrOwner } from "@/middleware/auth.middleware";
import { operatorParkingRateLimit } from "@/middleware/parkingRateLimit";
import { env } from "@/config/env";
import {
  activeHandler,
  awaitingPaymentHandler,
  capacityHandler,
  clearTestSessionsHandler,
  confirmCashPaymentHandler,
  entryManualHandler,
  exitManualHandler,
  forceCloseHandler,
  printReceiptHandler,
  sessionDetailHandler,
  sessionImageHandler,
  sessionsHandler,
  updatePaymentMethodHandler,
} from "./parking.controller";

const router = Router();

router.use(isAuth);

router.post("/entry/manual", operatorParkingRateLimit, asyncHandler(entryManualHandler));
router.post("/exit/manual", operatorParkingRateLimit, asyncHandler(exitManualHandler));
router.get("/capacity", asyncHandler(capacityHandler));
router.get("/active", asyncHandler(activeHandler));
router.get("/sessions", asyncHandler(sessionsHandler));
router.get("/sessions/awaiting-payment", isOperatorOrOwner, asyncHandler(awaitingPaymentHandler));
router.get("/sessions/:id", asyncHandler(sessionDetailHandler));
router.get("/sessions/:id/images/:kind", asyncHandler(sessionImageHandler));
router.post("/sessions/:id/force-close", asyncHandler(forceCloseHandler));
router.post("/sessions/:id/print-receipt", isOperatorOrOwner, asyncHandler(printReceiptHandler));
router.post("/sessions/:id/confirm-cash-payment", isOperatorOrOwner, asyncHandler(confirmCashPaymentHandler));
router.post("/sessions/:id/payment-method", asyncHandler(updatePaymentMethodHandler));

if (env.nodeEnv !== "production") {
  router.delete("/sessions/clear-test", asyncHandler(clearTestSessionsHandler));
}

export default router;
