import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { webhookRateLimit } from "@/middleware/webhookRateLimit";
import {
  resolveOrgByMedplusDiscountToken,
  resolveOrgByMedplusInpatientToken,
} from "@/middleware/medplusWebhookAuth";
import { discountWebhookHandler, inpatientWebhookHandler } from "./medplus.controller";

const router = Router();

router.post(
  "/:token/discount",
  webhookRateLimit,
  resolveOrgByMedplusDiscountToken,
  asyncHandler(discountWebhookHandler)
);
router.post(
  "/:token/inpatient",
  webhookRateLimit,
  resolveOrgByMedplusInpatientToken,
  asyncHandler(inpatientWebhookHandler)
);

export default router;
