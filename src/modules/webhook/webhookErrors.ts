export type WebhookErrorCode =
  | "unsupported_camera_brand"
  | "unsupported_camera_payload"
  | "plate_not_found"
  | "invalid_direction"
  | "organization_not_found"
  | "invalid_webhook_token";

export class WebhookError extends Error {
  code: WebhookErrorCode;
  details?: Record<string, unknown>;

  constructor(code: WebhookErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class UnsupportedCameraBrandError extends WebhookError {
  constructor(brand: string) {
    super("unsupported_camera_brand", `Unsupported camera brand: ${brand}`);
  }
}

export class UnsupportedCameraPayloadError extends WebhookError {
  constructor(message = "Kamera payload formati tanilmadi", details?: Record<string, unknown>) {
    super("unsupported_camera_payload", message, details);
  }
}

export class PlateNotFoundError extends WebhookError {
  constructor(message = "Payload tanildi, lekin nomer topilmadi", details?: Record<string, unknown>) {
    super("plate_not_found", message, details);
  }
}
