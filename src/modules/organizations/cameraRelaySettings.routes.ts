import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOwner } from "@/middleware/auth.middleware";
import {
  getCameraRelaySettingsHandler,
  updateCameraRelaySettingsHandler,
} from "./organizations.controller";

const router = Router();

router.use(isAuth, isSuperAdminOrOwner);
router.get("/:id/camera-relay-settings", asyncHandler(getCameraRelaySettingsHandler));
router.patch("/:id/camera-relay-settings", asyncHandler(updateCameraRelaySettingsHandler));

export default router;
