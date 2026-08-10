import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOwnerOrKassir } from "@/middleware/auth.middleware";
import { createHandler, listHandler, pendingSummaryHandler } from "./cashCollections.controller";

const router = Router();

router.use(isAuth, isSuperAdminOrOwnerOrKassir);

router.get("/:id/cash-collections/pending-summary", asyncHandler(pendingSummaryHandler));
router.post("/:id/cash-collections", asyncHandler(createHandler));
router.get("/:id/cash-collections", asyncHandler(listHandler));

export default router;
