import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdmin, isSuperAdminOrOwner } from "@/middleware/auth.middleware";
import { blockHandler, createHandler, listHandler, updateHandler } from "./users.controller";

const router = Router();

router.use(isAuth);

router.get("/", isSuperAdmin, asyncHandler(listHandler));
router.post("/", isSuperAdminOrOwner, asyncHandler(createHandler));
router.put("/:id", isSuperAdmin, asyncHandler(updateHandler));
router.patch("/:id/block", isSuperAdmin, asyncHandler(blockHandler));

export default router;
