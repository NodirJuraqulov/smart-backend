import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isSuperAdminOrOperatorOrOwner } from "@/middleware/auth.middleware";
import { createHandler, listHandler, updateHandler } from "./tariffs.controller";

const router = Router();

router.use(isAuth, checkPermission("tariffs"));

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:id", isSuperAdminOrOperatorOrOwner, asyncHandler(updateHandler));

export default router;
