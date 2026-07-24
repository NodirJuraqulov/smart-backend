import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { listHandler, updateHandler } from "./operatorPermissions.controller";

const router = Router({ mergeParams: true });

router.get("/", asyncHandler(listHandler));
router.put("/", asyncHandler(updateHandler));

export default router;
