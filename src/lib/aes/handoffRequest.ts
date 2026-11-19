import type { AesHandoff } from "@/lib/aes/aesHandoff";
import {
  createHandoff,
  newNonce,
  recordBlocked,
  sha256,
  canonicalJson,
  type AuditActor,
  type BlockedInput,
  type HandoffInput,
  type RequestMeta,
} from "@/lib/aes/audit";

/**
 * Logic behind POST /api/aes/handoff (kept apart from the route so it can be checked with
 * fakes). The browser calls this when the user confirms a filing or starts a status
 * inquiry; only the fields returned here are posted to CBP. Fail closed: if the record
 * can't be written, the response is an error and the browser sends nothing.
 */

export interface HandoffRequestBody {
  fileNumber?: unknown;
  kind?: unknown;
  action?: unknown;
  expectedHash?: unknown;
  prodAcknowledged?: unknown;
}

export interface HandoffDeps {
  buildHandoff: (fileNumber: string, nonce: string) => Promise<AesHandoff | null>;
  createHandoff?: (input: HandoffInput) => Promise<{ submissionId: string }>;
  recordBlocked?: (input: BlockedInput) => Promise<void>;
  newNonce?: () => string;
}

export type HandoffResponse =
  | { status: 200; body: { kind: "FILING" | "INQUIRY"; targetUrl: string; method: "POST" | "GET"; fields: Record<string, string>; submissionId: string } }
  | { status: 400 | 401 | 404 | 409 | 503; body: { error: string; reason?: string } };

const FILE_NUMBER = /^[A-Za-z0-9-]{1,30}$/;

/** Plain-language messages shown to the user for each refusal reason. */
const USER_MESSAGE: Record<string, string> = {
  disabled: "AES filing is turned off. Ask your administrator.",
  configError: "AES filing isn't set up correctly. Ask your administrator.",
  productionNotAcknowledged: "Please tick the box to confirm this is a real filing.",
  noFilerId: "Status checks aren't set up yet. Ask your administrator.",
  stale: "This shipment was changed after you opened this page. Reload the page, check the details, then try again.",
};
const HASH = /^[a-f0-9]{64}$/;

export async function processHandoffRequest(
  body: HandoffRequestBody,
  actor: AuditActor | null,
  meta: RequestMeta,
  deps: HandoffDeps
): Promise<HandoffResponse> {
  if (!actor) return { status: 401, body: { error: "Your session has expired — sign in again." } };

  const fileNumber = typeof body.fileNumber === "string" ? body.fileNumber.trim() : "";
  const kind = body.kind === "FILING" || body.kind === "INQUIRY" ? body.kind : null;
  const action = body.action === "A" || body.action === "R" ? body.action : null;
  const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : "";
  const prodAcknowledged = body.prodAcknowledged === true;
  if (!FILE_NUMBER.test(fileNumber) || !kind || (kind === "FILING" && (!action || !HASH.test(expectedHash)))) {
    return { status: 400, body: { error: "Something went wrong. Reload the page and try again." } };
  }

  const nonce = (deps.newNonce ?? newNonce)();
  const handoff = await deps.buildHandoff(fileNumber, nonce);
  if (!handoff) return { status: 404, body: { error: `Shipment ${fileNumber} not found.` } };

  const { config, mapping } = handoff;
  const env = config.environment;
  const envLabel = env === "cert" ? "staging" : "PRODUCTION";
  const block = deps.recordBlocked ?? recordBlocked;
  const blocked = async (reason: string, message: string, type: BlockedInput["type"] = "HANDOFF_BLOCKED", extra: Record<string, string> = {}) => {
    await block({
      type,
      shipmentId: handoff.shipmentId,
      fileNumber,
      environment: env,
      actor,
      meta,
      summary: `${kind === "FILING" ? `Filing (${action === "R" ? "Replace" : "Add"})` : "Status inquiry"} to CBP ${envLabel} refused: ${message}`,
      detail: { kind, action, reason, message, ...extra },
    });
    // The user sees plain language; the audit keeps the technical message.
    return { status: 409 as const, body: { error: USER_MESSAGE[reason] ?? "This can't be sent right now. Ask your administrator.", reason } };
  };

  if (!config.enabled) return blocked("disabled", "AES filing is turned off (AES_ENABLED=false).");
  if (config.configError) return blocked("configError", config.configError);
  if (env === "production" && !prodAcknowledged) {
    return blocked("productionNotAcknowledged", "Production filing needs the acknowledgement checkbox.");
  }
  if (kind === "INQUIRY" && !handoff.inquiry) {
    return blocked("noFilerId", "Status inquiry needs AES_FILER_ID to be configured.");
  }
  if (kind === "FILING" && handoff.fieldsHash !== expectedHash) {
    return blocked("stale", "This shipment changed after the AES page was opened. Reload the page, review the mapping again, then confirm.", "HANDOFF_STALE", {
      expectedHash,
      actualHash: handoff.fieldsHash,
    });
  }

  const fields: Record<string, string> =
    kind === "FILING" ? { ...mapping.fields, FAC: action as string } : { ...(handoff.inquiry as NonNullable<AesHandoff["inquiry"]>).fields };
  const targetUrl = kind === "FILING" ? config.filingUrl : config.inquiryUrl;
  const actorName = actor.name || actor.email;

  try {
    const { submissionId } = await (deps.createHandoff ?? createHandoff)({
      nonce,
      kind,
      action: kind === "FILING" ? action : null,
      shipmentId: handoff.shipmentId,
      fileNumber,
      srn: mapping.srn,
      environment: env,
      targetUrl,
      payload: fields,
      payloadHash: kind === "FILING" ? handoff.fieldsHash : sha256(canonicalJson(fields)),
      lineCount: mapping.lineCount,
      advisories: [...mapping.advisories, ...config.configWarnings.map((w) => `Setup: ${w}`)],
      actor,
      meta,
      summary:
        kind === "FILING"
          ? `Filing (${action === "R" ? "Replace" : "Add"}) sent to CBP ${envLabel} by ${actorName}`
          : `Status inquiry sent to CBP ${envLabel} by ${actorName}`,
      detail: {
        kind,
        action,
        srn: mapping.srn,
        lineCount: mapping.lineCount,
        payloadHash: kind === "FILING" ? handoff.fieldsHash : null,
        targetUrl,
        ...(env === "production" ? { prodAcknowledged } : {}),
        ...(kind === "INQUIRY" ? { returnsToTms: !!handoff.inquiry?.returnsToTms } : {}),
      },
    });
    return {
      status: 200,
      body: { kind, targetUrl, method: kind === "FILING" ? "POST" : "GET", fields, submissionId },
    };
  } catch (err) {
    console.error("[aes-audit] could not record hand-off — refusing it", fileNumber, err);
    return {
      status: 503,
      body: { error: "Couldn't save this step in TMS, so nothing was sent to CBP. Please try again in a moment.", reason: "auditUnavailable" },
    };
  }
}
