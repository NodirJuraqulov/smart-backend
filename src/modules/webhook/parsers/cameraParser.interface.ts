import { NormalizedCameraEvent } from "./normalizedCameraEvent";

export interface CameraParserOrganization {
  id: number;
  cameraBrand: string | null;
}

export interface WebhookTiming {
  t0: number;
  t1?: number;
  t2?: number;
  t3?: number;
  t4?: number;
  t5?: number;
  t6?: number;
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
  timing?: WebhookTiming;
}

export interface CameraParser {
  parse(input: CameraParserInput): Promise<NormalizedCameraEvent>;
}
