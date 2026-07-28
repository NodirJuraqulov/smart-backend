export interface NormalizedCameraEvent {
  plateNumber: string;
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
}
