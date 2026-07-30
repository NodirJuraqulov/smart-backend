export interface NormalizedCameraEvent {
  plateNumber: string | null;
  confidence: number | null;
  timestamp: Date | null;
  direction: "entry" | "exit";
  cameraBrand: string;
  deviceId?: string | null;
  plateImage?: Buffer | null;
  vehicleImage?: Buffer | null;
  overviewImage?: Buffer | null;
  metadata?: Record<string, unknown>;
  rawPayload?: unknown;
  overviewImageFileName?: string | null;
  vehicleImageFileName?: string | null;
  plateImageFileName?: string | null;
}
