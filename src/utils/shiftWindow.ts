import { DateTime } from "luxon";
import { ApiError } from "./ApiError";

export interface OrganizationShiftWindow {
  date: string;
  from: Date;
  to: Date;
}

export function getOrganizationShiftWindow(
  date: string,
  timezone: string
): OrganizationShiftWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError("date formati noto'g'ri (YYYY-MM-DD)", 400);
  }
  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid || day.toFormat("yyyy-MM-dd") !== date) {
    throw new ApiError("date formati noto'g'ri (YYYY-MM-DD)", 400);
  }
  const from = day.startOf("day").set({ hour: 8 });
  return {
    date,
    from: from.toJSDate(),
    to: from.plus({ days: 1 }).toJSDate(),
  };
}
