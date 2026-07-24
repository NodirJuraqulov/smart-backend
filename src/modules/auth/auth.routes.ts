import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth } from "@/middleware/auth.middleware";
import { loginIpRateLimit, loginUsernameRateLimit } from "@/middleware/loginRateLimit";
import { loginHandler, logoutHandler, meHandler, refreshHandler } from "./auth.controller";

const router = Router();

router.post("/login", loginIpRateLimit, loginUsernameRateLimit, asyncHandler(loginHandler));
router.post("/refresh", asyncHandler(refreshHandler));
router.post("/logout", asyncHandler(logoutHandler));
router.get("/me", isAuth, asyncHandler(meHandler));

export default router;
