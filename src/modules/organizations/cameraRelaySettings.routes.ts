import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdmin, isSuperAdminOrOwner } from "@/middleware/auth.middleware";
import {
  getCameraRelaySettingsHandler,
  resetTestDataHandler,
  updateCameraRelaySettingsHandler,
} from "./organizations.controller";

const router = Router();

router.use(isAuth);
router.post("/:id/reset-test-data", isSuperAdmin, asyncHandler(resetTestDataHandler));
router.get("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(getCameraRelaySettingsHandler));
router.patch("/:id/camera-relay-settings", isSuperAdminOrOwner, asyncHandler(updateCameraRelaySettingsHandler));

export default router;
