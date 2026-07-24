import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isOperatorOrOwner } from "@/middleware/auth.middleware";
import {
  createHandler,
  deleteHandler,
  listHandler,
  renewHandler,
  updateHandler,
} from "./subscriptions.controller";

const router = Router();

router.use(isAuth, isOperatorOrOwner, checkPermission("subscriptions"));

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:id", asyncHandler(updateHandler));
router.post("/:id/renew", asyncHandler(renewHandler));
router.delete("/:id", asyncHandler(deleteHandler));

export default router;
