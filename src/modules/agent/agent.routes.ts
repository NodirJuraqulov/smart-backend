import { Router } from "express";
import { agentAuth } from "@/middleware/agentAuth";
import { asyncHandler } from "@/middleware/asyncHandler";
import { agentParkingRateLimit } from "@/middleware/parkingRateLimit";
import { upload } from "@/middleware/upload";
import { configHandler, entryHandler, exitHandler, heartbeatHandler, verifyHandler } from "./agent.controller";

const router = Router();

router.use(agentAuth);

router.post("/entry", agentParkingRateLimit, upload.single("image"), asyncHandler(entryHandler));
router.post("/exit", agentParkingRateLimit, upload.single("image"), asyncHandler(exitHandler));
router.post("/verify", agentParkingRateLimit, upload.single("image"), asyncHandler(verifyHandler));

export default router;

export const agentConfigRouter = Router();
agentConfigRouter.use(agentAuth);
agentConfigRouter.get("/", asyncHandler(configHandler));

export const agentHeartbeatRouter = Router();
agentHeartbeatRouter.use(agentAuth);
agentHeartbeatRouter.post("/", asyncHandler(heartbeatHandler));
