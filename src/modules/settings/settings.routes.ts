import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import { generateAgentKeyHandler, getHandler, testBarrierHandler, updateHandler } from "./settings.controller";

const router = Router();

router.use(isAuth, checkPermission("settings"));

router.get("/", asyncHandler(getHandler));
router.put("/", isSuperAdmin, asyncHandler(updateHandler));
router.post("/barrier/test", asyncHandler(testBarrierHandler));
router.post("/agent-key/generate", isSuperAdmin, asyncHandler(generateAgentKeyHandler));

export default router;
