import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isOwner } from "@/middleware/auth.middleware";
import {
  createReviewHandler,
  listAuditHandler,
  listReviewsHandler,
  searchHandler,
} from "./forcedOpenAudit.controller";

const router = Router();

router.use(isAuth, isOwner);
router.get("/", asyncHandler(listAuditHandler));
router.post("/search", asyncHandler(searchHandler));
router.post("/reviews", asyncHandler(createReviewHandler));
router.get("/reviews", asyncHandler(listReviewsHandler));

export default router;
