import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { createHandler, deleteHandler, listHandler, updateHandler } from "./tariffIntervals.controller";

const router = Router({ mergeParams: true });

router.get("/", asyncHandler(listHandler));
router.post("/", asyncHandler(createHandler));
router.put("/:intervalId", asyncHandler(updateHandler));
router.delete("/:intervalId", asyncHandler(deleteHandler));

export default router;
