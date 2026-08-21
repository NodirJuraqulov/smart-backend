import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import {
  isAuth,
  isSuperAdmin,
  isSuperAdminOrOperatorOrOwner,
  isSuperAdminOrOwner,
} from "@/middleware/auth.middleware";
import {
  emergencyBarrierOpenHandler,
  gateLayoutHandler,
  getEmergencyBarrierSettingsHandler,
  updateEmergencyBarrierSettingsHandler,
  getCameraRelaySettingsHandler,
  getLedSettingsHandler,
  expireStaleExitCandidatesHandler,
  resetTestDataHandler,
  staleSessionsHandler,
  updateCameraRelaySettingsHandler,
  updateLedSettingsHandler,
} from "./organizations.controller";

const router = Router();

router.use(isAuth);
router.post("/:id/reset-test-data", isSuperAdmin, asyncHandler(resetTestDataHandler));
router.post(
  "/:id/expire-stale-exit-candidates",
  isSuperAdmin,
  asyncHandler(expireStaleExitCandidatesHandler)
);
router.post(
  "/:id/emergency-barrier-open",
  isSuperAdminOrOperatorOrOwner,
  asyncHandler(emergencyBarrierOpenHandler)
);
router.get("/:id/gate-layout", isSuperAdminOrOperatorOrOwner, asyncHandler(gateLayoutHandler));
router.get(
  "/:id/emergency-barrier-settings",
  isSuperAdminOrOperatorOrOwner,
  asyncHandler(getEmergencyBarrierSettingsHandler)
);
router.patch(
  "/:id/emergency-barrier-settings",
  isSuperAdminOrOwner,
  asyncHandler(updateEmergencyBarrierSettingsHandler)
);
router.get("/:id/stale-sessions", isSuperAdminOrOwner, asyncHandler(staleSessionsHandler));
router.get("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(getCameraRelaySettingsHandler));
router.patch("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(updateCameraRelaySettingsHandler));
router.get("/:id/led-settings", isSuperAdminOrOwner, asyncHandler(getLedSettingsHandler));
router.patch("/:id/led-settings", isSuperAdmin, asyncHandler(updateLedSettingsHandler));

export default router;
