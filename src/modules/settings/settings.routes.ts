import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import { getHandler, updateHandler } from "./settings.controller";

const router = Router();

router.use(isAuth, checkPermission("settings"));

router.get("/", asyncHandler(getHandler));
router.put("/", isSuperAdmin, asyncHandler(updateHandler));

export default router;
