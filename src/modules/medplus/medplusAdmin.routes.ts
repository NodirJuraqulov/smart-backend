import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { isAuth, isSuperAdminOrOperatorOrOwner, isSuperAdminOrOwner } from "@/middleware/auth.middleware";
import {
  cancelClinicDiscountHandler,
  cancelInpatientVehicleHandler,
  getClinicDiscountSettingsHandler,
  listClinicDiscountsHandler,
  listInpatientVehiclesHandler,
  updateClinicDiscountSettingsHandler,
} from "./medplus.controller";

const router = Router();

router.use(isAuth);
router.get("/:id/clinic-discounts", isSuperAdminOrOperatorOrOwner, asyncHandler(listClinicDiscountsHandler));
router.post(
  "/:id/clinic-discounts/:discountId/cancel",
  isSuperAdminOrOwner,
  asyncHandler(cancelClinicDiscountHandler)
);
router.get("/:id/inpatient-vehicles", isSuperAdminOrOperatorOrOwner, asyncHandler(listInpatientVehiclesHandler));
router.post(
  "/:id/inpatient-vehicles/:vehicleId/cancel",
  isSuperAdminOrOwner,
  asyncHandler(cancelInpatientVehicleHandler)
);
router.get(
  "/:id/clinic-discount-settings",
  isSuperAdminOrOwner,
  asyncHandler(getClinicDiscountSettingsHandler)
);
router.patch(
  "/:id/clinic-discount-settings",
  isSuperAdminOrOwner,
  asyncHandler(updateClinicDiscountSettingsHandler)
);

export default router;
