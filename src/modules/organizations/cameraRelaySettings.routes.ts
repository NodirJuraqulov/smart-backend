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
  getCameraRelaySettingsHandler,
  expireStaleExitCandidatesHandler,
  resetTestDataHandler,
  staleSessionsHandler,
  updateCameraRelaySettingsHandler,
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
router.get("/:id/stale-sessions", isSuperAdminOrOwner, asyncHandler(staleSessionsHandler));
router.get("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(getCameraRelaySettingsHandler));
router.patch("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(updateCameraRelaySettingsHandler));

export default router;
