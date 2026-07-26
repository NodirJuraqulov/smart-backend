import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import operatorPermissionsRouter from "@/modules/operatorPermissions/operatorPermissions.routes";
import tariffIntervalsRouter from "@/modules/tariffIntervals/tariffIntervals.routes";
import {
  addOperatorHandler,
  blockHandler,
  capacityHandler,
  createHandler,
  getIntegrationSettingsHandler,
  globalStatsHandler,
  listHandler,
  pricingModeHandler,
  printerTestHandler,
  regenerateWebhookTokenHandler,
  relayTestHandler,
  statsHandler,
  updateHandler,
  updateIntegrationSettingsHandler,
} from "./organizations.controller";

const router = Router();

router.use(isAuth, isSuperAdmin);

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:id", asyncHandler(updateHandler));
router.patch("/:id/block", asyncHandler(blockHandler));
router.get("/:id/stats", asyncHandler(statsHandler));
router.put("/:id/pricing-mode", asyncHandler(pricingModeHandler));
router.put("/:id/capacity", asyncHandler(capacityHandler));
router.post("/:id/operator", asyncHandler(addOperatorHandler));
router.post("/:id/relay/test", asyncHandler(relayTestHandler));
router.post("/:id/printer/test", asyncHandler(printerTestHandler));
router.get("/:id/integration-settings", asyncHandler(getIntegrationSettingsHandler));
router.put("/:id/integration-settings", asyncHandler(updateIntegrationSettingsHandler));
router.post("/:id/integration-settings/regenerate-token", asyncHandler(regenerateWebhookTokenHandler));
router.use("/:id/tariff-intervals", tariffIntervalsRouter);
router.use("/:id/permissions", operatorPermissionsRouter);

export const adminStatsRouter = Router();
adminStatsRouter.get("/", isAuth, isSuperAdmin, asyncHandler(globalStatsHandler));

export default router;
