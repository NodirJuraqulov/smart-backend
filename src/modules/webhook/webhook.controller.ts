import { Request, Response } from "express";
import { db } from "@/config/db";
import { cameraParserFactory } from "./parsers/cameraParserFactory";
import { CameraParserInput } from "./parsers/cameraParser.interface";
import { NormalizedCameraEvent } from "./parsers/normalizedCameraEvent";
import { IgnoredCameraSignalError, UnsupportedCameraBrandError, WebhookError } from "./webhookErrors";
import { logWebhookDebug } from "./webhookDebugLog.service";
import {
  recordWebhookAuditEvent,
  registerWebhookEvent,
  updateWebhookEventOutcome,
} from "./webhookIdempotency";
import { processEntryWebhook } from "@/modules/entryCandidates/entryCandidates.service";
import { emitPlateNotRecognizedForExit, emitWebhookParseFailed } from "@/websocket/socketServer";
import { createExitCandidate } from "@/modules/exitCandidates/exitCandidates.service";
import { tryAutoExit, wasRecentlyAutoExited } from "@/modules/exitCandidates/autoExit.service";
import {
  markDuplicateImagesSkipped,
  saveWebhookEventImages,
} from "./webhookEventImage.service";
import { hasDetectedVehicleRegion, normalizeDetectedPlate } from "./webhookRules";
import {
  getPlateFormatValidationDecision,
  validateOrTrackPlateFormat,
} from "@/modules/plateFormats/plateFormatCheck.service";

const DEFAULT_CAMERA_BRAND = "hikvision";

async function touchLastWebhookAt(orgId: number, direction: "entry" | "exit"): Promise<void> {
  const column = direction === "entry" ? "last_webhook_entry_at" : "last_webhook_exit_at";
  await db("tb_organizations")
    .where({ id: orgId })
    .update({ [column]: new Date() });
}

export async function debugHandler(req: Request, res: Response) {
  const direction = req.params.direction as "entry" | "exit";
  await logWebhookDebug(req.webhookOrgId!, direction, req);
  res.status(200).json({ ok: true });
}

function buildParserInput(
  req: Request,
  direction: "entry" | "exit",
  organization: { id: number; cameraBrand: string | null }
): CameraParserInput {
  return {
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    headers: req.headers,
    query: req.query,
    contentType: (req.headers["content-type"] as string | undefined) ?? "",
    direction,
    organization,
  };
}

async function processCameraWebhook(
  req: Request,
  res: Response,
  cameraBrand: string,
  organizationCameraBrand: string | null
) {
  const direction = req.params.direction as "entry" | "exit";
  const orgId = req.webhookOrgId!;

  await touchLastWebhookAt(orgId, direction);

  let parser;
  try {
    parser = cameraParserFactory.getParser(cameraBrand);
  } catch (err) {
    if (err instanceof UnsupportedCameraBrandError) {
      console.warn(`Webhook: ${err.message} (org_id: ${orgId})`);
      res.status(400).json({ ok: false, message: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const input = buildParserInput(req, direction, { id: orgId, cameraBrand: organizationCameraBrand });

  let event: NormalizedCameraEvent;
  try {
    event = await parser.parse(input);
  } catch (err) {
    if (err instanceof IgnoredCameraSignalError) {
      res.status(200).json({ ok: true, parsed: false, ignored: true });
      return;
    }
    if (err instanceof WebhookError) {
      try {
        await recordWebhookAuditEvent({
          orgId,
          direction,
          processingResult: "parse_failed",
          processingReason: err.code,
        });
      } catch (auditErr) {
        console.error(
          "Webhook parse auditini yozib bo'lmadi:",
          auditErr instanceof Error ? auditErr.message : auditErr
        );
      }
      try {
        await logWebhookDebug(orgId, direction, req);
      } catch (debugLogErr) {
        console.error("Webhook debug logini yozib bo'lmadi:", debugLogErr);
      }
      emitWebhookParseFailed(orgId, {
        direction,
        message: "Kamera signal yubordi, lekin format tanilmadi",
      });
      res.status(200).json({ ok: true, parsed: false });
      return;
    }
    throw err;
  }
  const plateNumber = normalizeDetectedPlate(event.plateNumber);
  event = { ...event, plateNumber };

  console.log(
    `Camera event: brand=${cameraBrand} org_id=${orgId} direction=${direction} plate=${plateNumber ?? "null"} ` +
      `confidence=${event.confidence ?? "null"} device_id=${event.deviceId ?? "unknown"}`
  );

  const deviceId = event.deviceId?.trim() || `${cameraBrand}:${direction}`;
  const formatDecision = req.webhookPlateFormatValidationEnabled
    ? await getPlateFormatValidationDecision(orgId, plateNumber)
    : { enabled: false, valid: true };
  const registration = formatDecision.enabled && !formatDecision.valid
    ? {
        status: "accepted" as const,
        eventId: await recordWebhookAuditEvent({
          orgId,
          direction,
          plateNumber,
          confidence: event.confidence,
          deviceId: event.deviceId,
          cameraEventAt: event.timestamp,
          processingResult: "plate_format_received",
          processingReason: "validation_pending",
        }),
      }
    : await registerWebhookEvent(orgId, plateNumber, direction, {
        confidence: event.confidence,
        deviceId: event.deviceId,
        cameraEventAt: event.timestamp,
      });
  if (!hasDetectedVehicleRegion(event)) {
    await saveWebhookEventImages({
      orgId,
      eventId: registration.eventId,
      direction,
      event,
    }).catch((err) => {
      console.warn(
        `Webhook event rasmlari saqlanmadi: org_id=${orgId} event_id=${registration.eventId} ` +
          `direction=${direction} error=${err instanceof Error ? err.message : String(err)}`
      );
    });
    await updateWebhookEventOutcome(registration.eventId, {
      processingResult: "no_vehicle_detected_ignored",
      processingReason: "vehicle_region_missing",
      processed: true,
    });
    res.status(200).json({
      ok: true,
      parsed: true,
      ignored: true,
      reason: "no_vehicle_detected_ignored",
      plate_number: plateNumber,
      confidence: event.confidence,
      timestamp: event.timestamp,
    });
    return;
  }
  if (registration.status === "same_direction_duplicate") {
    await markDuplicateImagesSkipped(orgId, registration.eventId).catch((err) => {
      console.warn(
        `Duplicate image audit yozilmadi: org_id=${orgId} event_id=${registration.eventId} ` +
          `error=${err instanceof Error ? err.message : String(err)}`
      );
    });
    console.log(
      `Webhook: takroriy hodisa, e'tiborsiz qoldirildi (org_id: ${orgId}, plate: ${plateNumber}, ${direction})`
    );
    res.status(200).json({ ok: true, parsed: true, duplicate: true });
    return;
  }

  await saveWebhookEventImages({
    orgId,
    eventId: registration.eventId,
    direction,
    event,
  }).catch((err) => {
    console.warn(
      `Webhook event rasmlari saqlanmadi: org_id=${orgId} event_id=${registration.eventId} ` +
        `direction=${direction} error=${err instanceof Error ? err.message : String(err)}`
    );
  });

  if (registration.status === "opposite_camera_echo") {
    console.log(
      `Opposite camera echo ignored: org_id=${orgId} plate=${plateNumber} ` +
        `first=${registration.firstDirection} ignored=${direction} delta_seconds=${registration.deltaSeconds}`
    );
    res.status(200).json({
      ok: true,
      parsed: true,
      ignored: true,
      reason: "opposite_camera_echo",
    });
    return;
  }
  if (registration.status === "shared_lane_conflict") {
    console.warn(
      `Shared lane conflict ignored: org_id=${orgId} first_plate=${registration.firstPlateNumber} ` +
        `plate=${plateNumber} first=${registration.firstDirection} ignored=${direction} ` +
        `delta_seconds=${registration.deltaSeconds}`
    );
    res.status(200).json({
      ok: true,
      parsed: true,
      ignored: true,
      reason: "shared_lane_conflict",
    });
    return;
  }

  const formatValidation = formatDecision.enabled
    ? await validateOrTrackPlateFormat({
        orgId,
        direction,
        deviceId,
        detectedPlate: plateNumber,
        webhookEventId: registration.eventId,
        decision: formatDecision,
      })
    : { status: "proceed" as const };
  if (formatValidation.status === "waiting") {
    res.status(200).json({
      ok: true,
      parsed: true,
      plate_format_waiting: true,
      attempts: formatValidation.attempts,
      deadline_at: formatValidation.deadlineAt.toISOString(),
      plate_number: plateNumber,
      confidence: event.confidence,
      timestamp: event.timestamp,
    });
    return;
  }
  if (formatValidation.status === "finalized") {
    res.status(200).json({
      ok: true,
      parsed: true,
      candidate_created: formatValidation.candidateCreated,
      candidate_coalesced: formatValidation.candidateCoalesced,
      candidate_id: formatValidation.candidateId,
      plate_number: null,
      suggested_plate: formatValidation.suggestedPlate,
      confidence: event.confidence,
      timestamp: event.timestamp,
    });
    return;
  }
  if (formatValidation.status === "cancelled") {
    res.status(200).json({ ok: true, parsed: true, ignored: true });
    return;
  }

  if (direction === "exit") {
    const autoExit = await tryAutoExit({
      orgId,
      webhookEventId: registration.eventId,
      plateNumber,
    });
    if (autoExit) {
      console.log(
        `Auto exit: org_id=${orgId} plate=${autoExit.plateNumber} reason=${autoExit.reason} ` +
          `session_id=${autoExit.sessionId} barrier=${autoExit.barrierStatus}`
      );
      res.status(200).json({
        ok: true,
        parsed: true,
        auto_exit: true,
        reason: autoExit.reason,
        session_id: autoExit.sessionId,
        barrier_status: autoExit.barrierStatus,
        plate_number: plateNumber,
        confidence: event.confidence,
        timestamp: event.timestamp,
      });
      return;
    }

    if (plateNumber && (await wasRecentlyAutoExited(orgId, plateNumber))) {
      await updateWebhookEventOutcome(registration.eventId, {
        processingResult: "duplicate_after_auto_exit",
        processingReason: "auto_exit_cooldown",
        processed: true,
      });
      console.log(
        `Duplicate after auto exit ignored: org_id=${orgId} plate=${plateNumber} event_id=${registration.eventId}`
      );
      res.status(200).json({
        ok: true,
        parsed: true,
        ignored: true,
        reason: "duplicate_after_auto_exit",
        plate_number: plateNumber,
        confidence: event.confidence,
        timestamp: event.timestamp,
      });
      return;
    }

    const result = await createExitCandidate({
      orgId,
      webhookEventId: registration.eventId,
      detectedPlate: plateNumber,
      confidence: event.confidence,
    });
    if (result.skipped) {
      res.status(200).json({
        ok: true,
        parsed: true,
        ignored: true,
        reason: result.reason,
        session_id: result.sessionId,
        plate_number: plateNumber,
        confidence: event.confidence,
        timestamp: event.timestamp,
      });
      return;
    }
    if (!plateNumber) {
      emitPlateNotRecognizedForExit(orgId, {
        plateNumber: null,
        eventId: registration.eventId,
        candidateId: result.candidate.id,
        message: "Kamera davlat raqamini aniqlay olmadi — operator tekshiruvi kerak",
      });
    }
    res.status(200).json({
      ok: true,
      parsed: true,
      candidate_created: result.created,
      candidate_coalesced: result.coalesced,
      candidate_id: result.candidate.id,
      plate_number: plateNumber,
      confidence: event.confidence,
      timestamp: event.timestamp,
    });
    return;
  }

  const entryResult = await processEntryWebhook({
    orgId,
    webhookEventId: registration.eventId,
    event: { ...event, plateNumber },
  });

  res.status(200).json({
    ok: true,
    parsed: true,
    candidate_created: !entryResult.created && "candidateId" in entryResult,
    candidate_id: "candidateId" in entryResult ? entryResult.candidateId : undefined,
    reason: entryResult.reason,
    plate_number: plateNumber,
    confidence: event.confidence,
    timestamp: event.timestamp,
  });
}

export async function hikvisionHandler(req: Request, res: Response) {
  await processCameraWebhook(req, res, DEFAULT_CAMERA_BRAND, null);
}

export async function cameraHandler(req: Request, res: Response) {
  const orgId = req.webhookOrgId!;
  const organization = await db("tb_organizations").select("camera_brand").where({ id: orgId }).first();
  const cameraBrand = organization?.camera_brand || DEFAULT_CAMERA_BRAND;

  await processCameraWebhook(req, res, cameraBrand, organization?.camera_brand ?? null);
}
