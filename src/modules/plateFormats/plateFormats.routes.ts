import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import {
  isAuth,
  isSuperAdmin,
  isSuperAdminOrOperatorOrOwner,
} from "@/middleware/auth.middleware";
import {
  createHandler,
  deleteHandler,
  getSettingHandler,
  listHandler,
  updateHandler,
  updateSettingHandler,
} from "./plateFormats.controller";

const router = Router();

router.use(isAuth);
router.get("/:id/plate-formats", isSuperAdminOrOperatorOrOwner, asyncHandler(listHandler));
router.post("/:id/plate-formats", isSuperAdmin, asyncHandler(createHandler));
router.patch("/:id/plate-formats/:formatId", isSuperAdmin, asyncHandler(updateHandler));
router.delete("/:id/plate-formats/:formatId", isSuperAdmin, asyncHandler(deleteHandler));
router.get(
  "/:id/plate-format-validation-setting",
  isSuperAdminOrOperatorOrOwner,
  asyncHandler(getSettingHandler)
);
router.patch(
  "/:id/plate-format-validation-setting",
  isSuperAdmin,
  asyncHandler(updateSettingHandler)
);

export default router;
