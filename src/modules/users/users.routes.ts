import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdmin } from "@/middleware/auth.middleware";
import { blockHandler, createHandler, listHandler, updateHandler } from "./users.controller";

const router = Router();

router.use(isAuth, isSuperAdmin);

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:id", asyncHandler(updateHandler));
router.patch("/:id/block", asyncHandler(blockHandler));

export default router;
