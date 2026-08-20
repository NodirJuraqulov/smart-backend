import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOwner } from "@/middleware/auth.middleware";
import { attemptsHandler, createHandler, deleteHandler, listHandler } from "./blacklist.controller";

const router = Router();

router.use(isAuth, isSuperAdminOrOwner);
router.get("/:id/blacklist", asyncHandler(listHandler));
router.post("/:id/blacklist", asyncHandler(createHandler));
router.delete("/:id/blacklist/:blacklistId", asyncHandler(deleteHandler));
router.get("/:id/blacklist-attempts", asyncHandler(attemptsHandler));

export default router;
