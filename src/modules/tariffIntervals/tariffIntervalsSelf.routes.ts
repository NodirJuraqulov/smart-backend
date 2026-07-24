import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { checkPermission, isAuth, isOperatorOrOwner } from "@/middleware/auth.middleware";
import { createHandler, deleteHandler, listHandler, updateHandler } from "./tariffIntervalsSelf.controller";

const router = Router();

router.use(isAuth, isOperatorOrOwner, checkPermission("tariffs"));

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:intervalId", asyncHandler(updateHandler));
router.delete("/:intervalId", asyncHandler(deleteHandler));

export default router;
