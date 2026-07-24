import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

export interface OcrResult {
  detected: boolean;
  plate: string | null;
  confidence: number;
  candidateFound: boolean;
}

const NOT_DETECTED: OcrResult = { detected: false, plate: null, confidence: 0, candidateFound: true };
const REQUEST_TIMEOUT_MS = 10000;

export async function detectPlate(imageBase64: string): Promise<OcrResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    const imageBuffer = Buffer.from(imageBase64, "base64");

    const formData = new FormData();
    formData.append("image", new Blob([imageBuffer]), "plate.jpg");

    response = await fetch(`${env.pythonOcrUrl}/detect`, {
      method: "POST",
      body: formData,
      headers: { "X-Internal-Key": env.internalApiKey },
      signal: controller.signal,
    });
  } catch {
    return NOT_DETECTED;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 400) {
    throw new ApiError("Rasm formati noto'g'ri", 400);
  }

  if (!response.ok) {
    return NOT_DETECTED;
  }

  try {
    const data = (await response.json()) as Partial<OcrResult> & { candidate_found?: boolean };
    return {
      detected: Boolean(data.detected),
      plate: data.plate ?? null,
      confidence: data.confidence ?? 0,
      candidateFound: data.candidate_found ?? true,
    };
  } catch {
    return NOT_DETECTED;
  }
}
