import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth } from "@/middleware/auth.middleware";
import { liveViewHandler } from "./liveView.controller";

const router = Router();

router.get("/", isAuth, asyncHandler(liveViewHandler));

export default router;
