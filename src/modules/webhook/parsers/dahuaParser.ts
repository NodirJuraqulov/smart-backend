import { CameraParser, CameraParserInput } from "./cameraParser.interface";
import { NormalizedCameraEvent } from "./normalizedCameraEvent";
import { UnsupportedCameraPayloadError } from "../webhookErrors";

const MAX_RAW_PAYLOAD_PREVIEW_BYTES = 2000;

export const dahuaParser: CameraParser = {
  async parse(input: CameraParserInput): Promise<NormalizedCameraEvent> {
    throw new UnsupportedCameraPayloadError(
      "Dahua parser hali to'liq amalga oshirilmagan — real payload namunasi kutilmoqda",
      {
        cameraBrand: "dahua",
        contentType: input.contentType,
        rawPayloadPreview: input.rawBody.subarray(0, MAX_RAW_PAYLOAD_PREVIEW_BYTES).toString("utf8"),
      }
    );
  },
};
