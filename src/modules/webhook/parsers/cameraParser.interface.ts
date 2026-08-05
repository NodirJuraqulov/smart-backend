import { NormalizedCameraEvent } from "./normalizedCameraEvent";

export interface CameraParserOrganization {
  id: number;
  cameraBrand: string | null;
}

export interface CameraParserInput {
  rawBody: Buffer;
  parsedBody?: unknown;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  files?: unknown;
  contentType: string;
  direction: "entry" | "exit";
  organization: CameraParserOrganization;
}

export interface CameraParser {
  parse(input: CameraParserInput): Promise<NormalizedCameraEvent>;
}
