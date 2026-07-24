import { Request, Response } from "express";
import { resolveImageInput } from "@/utils/httpParams";
import * as parkingService from "@/modules/parking/parking.service";
import * as settingsService from "@/modules/settings/settings.service";
import { detectPlate } from "@/services/ocr.service";
import { ApiError } from "@/utils/ApiError";

export async function entryHandler(req: Request, res: Response) {
  const result = await parkingService.entryAuto(
    req.orgId!,
    null,
    resolveImageInput(req),
    req.body?.captured_at
  );
  res.status(result.detected ? 201 : 200).json(result);
}

export async function exitHandler(req: Request, res: Response) {
  const result = await parkingService.exitAuto(
    req.orgId!,
    null,
    resolveImageInput(req),
    req.body?.captured_at
  );
  res.status(200).json(result);
}

export async function configHandler(req: Request, res: Response) {
  const config = await settingsService.getAgentConfig(req.orgId!);
  res.json(config);
}

export async function verifyHandler(req: Request, res: Response) {
  const image = resolveImageInput(req);
  if (!image) {
    throw new ApiError("Rasm topilmadi", 400);
  }

  const result = await detectPlate(image);
  res.json({ plate: result.plate, confidence: result.confidence });
}

function parseNullableBoolean(value: unknown): boolean | null | undefined {
  if (value === true || value === false || value === null) {
    return value;
  }
  return undefined;
}

export async function heartbeatHandler(req: Request, res: Response) {
  const cameraEntryOk = parseNullableBoolean(req.body?.camera_entry_ok);
  const cameraExitOk = parseNullableBoolean(req.body?.camera_exit_ok);

  await settingsService.recordHeartbeat(req.orgId!, cameraEntryOk, cameraExitOk);
  res.json({ ok: true });
}
