import { NormalizedCameraEvent } from "./parsers/normalizedCameraEvent";
import { editDistanceAtMostOne } from "./webhookIdempotency";

export const MIN_DETECTED_PLATE_LENGTH = 3;
export const MIN_FUZZY_PLATE_LENGTH = 6;
export const FUZZY_ENTRY_DUPLICATE_WINDOW_SECONDS = 30;
export const NULL_PLATE_COALESCE_WINDOW_MS = 5 * 60_000;
export const RESOLVED_EXIT_CANDIDATE_COOLDOWN_MS = 10 * 60_000;

export function isFuzzyPlateMatch(detectedPlate: string, candidatePlate: string | null): boolean {
  if (!candidatePlate) return false;
  if (
    detectedPlate.length < MIN_FUZZY_PLATE_LENGTH ||
    candidatePlate.length < MIN_FUZZY_PLATE_LENGTH
  ) {
    return false;
  }
  return editDistanceAtMostOne(detectedPlate, candidatePlate);
}

export function normalizeDetectedPlate(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "";
  return normalized.length >= MIN_DETECTED_PLATE_LENGTH ? normalized : null;
}

export function hasDetectedVehicleRegion(event: NormalizedCameraEvent): boolean {
  return Boolean(
    event.vehicleImage?.length ||
      event.metadata?.vehicleImageSource === "normal_vehicle_bbox_crop" ||
      event.metadata?.normalizedVehicleBoundingBox
  );
}
