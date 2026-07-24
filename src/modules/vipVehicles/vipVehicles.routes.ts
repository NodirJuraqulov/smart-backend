import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isOperatorOrOwner } from "@/middleware/auth.middleware";
import { createHandler, deleteHandler, listHandler, updateHandler } from "./vipVehicles.controller";

const router = Router();

router.use(isAuth, isOperatorOrOwner);

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:id", asyncHandler(updateHandler));
router.delete("/:id", asyncHandler(deleteHandler));

export default router;
