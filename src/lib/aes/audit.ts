import { createHash, randomBytes } from "crypto";
import type { AesAuditEventType, AesSubmissionKind, AesSubmissionOutcome, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ITN_PATTERN } from "@/lib/aes/codes";
import { escapeRegex } from "@/lib/mongoText";

// AES audit log. Only place that touches AesSubmission / AesAuditEvent.
// Append-only. Every write is also logged as "[aes-audit] ..." in case the DB write fails.

// Max CBP returns saved per filing.
export const MAX_RETURNS_PER_SUBMISSION = 5;
// 22-char random id.
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
// After this, a pending filing shows "no return from CBP".
export const NO_RETURN_AFTER_MS = 24 * 60 * 60 * 1000;

// Left out of the change check (they differ on every send).
const VOLATILE_FIELDS = new Set(["wl_success_url", "wl_nosed_url", "URL", "FAC"]);

// Only what we use from Prisma (easy to fake in tests).
export type AuditDb = Pick<PrismaClient, "aesSubmission" | "aesAuditEvent" | "$transaction">;

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

// JSON with sorted keys, so the hash is stable.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Hash used to spot a shipment that changed after the page loaded.
export function fieldsHash(fields: Record<string, string>): string {
  const stable: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (!VOLATILE_FIELDS.has(k)) stable[k] = v;
  return sha256(canonicalJson(stable));
}

// ---- Request metadata ----

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  refererHost: string | null;
}

// IP, browser and referer from headers. For info only.
export function requestMeta(headers: Headers): RequestMeta {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (forwarded || headers.get("x-real-ip") || "").slice(0, 64) || null;
  const userAgent = (headers.get("user-agent") ?? "").slice(0, 300) || null;
  let refererHost: string | null = null;
  try {
    const ref = headers.get("referer");
    if (ref) refererHost = new URL(ref).host.slice(0, 200);
  } catch {
    refererHost = null;
  }
  return { ip, userAgent, refererHost };
}

export interface AuditActor {
  userId: string;
  email: string;
  name: string;
}

function mirror(event: Record<string, unknown>): void {
  console.info(`[aes-audit] ${JSON.stringify(event)}`);
}

// ---- Writers ----

export interface BlockedInput {
  type: Extract<AesAuditEventType, "HANDOFF_BLOCKED" | "HANDOFF_STALE">;
  shipmentId: string | null;
  fileNumber: string;
  environment: string;
  actor: AuditActor;
  meta: RequestMeta;
  summary: string;
  detail: Prisma.InputJsonValue;
}

// Blocked send. Never throws.
export async function recordBlocked(input: BlockedInput, db: AuditDb = prisma): Promise<void> {
  mirror({ type: input.type, fileNumber: input.fileNumber, environment: input.environment, userId: input.actor.userId, summary: input.summary });
  try {
    await db.aesAuditEvent.create({
      data: {
        type: input.type,
        shipmentId: input.shipmentId,
        fileNumber: input.fileNumber,
        environment: input.environment,
        actorType: "USER",
        userId: input.actor.userId,
        userEmail: input.actor.email,
        userName: input.actor.name,
        summary: input.summary,
        detail: input.detail,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
  } catch (err) {
    console.error("[aes-audit] failed to record blocked hand-off", input.fileNumber, err);
  }
}

// AES details saved. Never throws.
export async function recordDetailsSaved(
  input: { shipmentId: string; fileNumber: string; environment: string; actor: AuditActor; meta: RequestMeta; changed: string[] },
  db: AuditDb = prisma
): Promise<void> {
  const summary = `AES details saved by ${input.actor.name || input.actor.email}${input.changed.length ? ` (${input.changed.length} change${input.changed.length === 1 ? "" : "s"})` : " (no changes)"}`;
  mirror({ type: "DETAILS_SAVED", fileNumber: input.fileNumber, userId: input.actor.userId, changed: input.changed.length });
  try {
    await db.aesAuditEvent.create({
      data: {
        type: "DETAILS_SAVED",
        shipmentId: input.shipmentId,
        fileNumber: input.fileNumber,
        environment: input.environment,
        actorType: "USER",
        userId: input.actor.userId,
        userEmail: input.actor.email,
        userName: input.actor.name,
        summary,
        detail: { changed: input.changed.slice(0, 100) },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
  } catch (err) {
    console.error("[aes-audit] failed to record AES details save", input.fileNumber, err);
  }
}

export interface HandoffInput {
  nonce: string;
  kind: AesSubmissionKind;
  action: "A" | "R" | null;
  shipmentId: string;
  fileNumber: string;
  srn: string;
  environment: string;
  targetUrl: string;
  payload: Record<string, string>;
  payloadHash: string;
  lineCount: number;
  advisories: string[];
  actor: AuditActor;
  meta: RequestMeta;
  summary: string;
  detail: Prisma.InputJsonValue;
}

// Records a send. Throws on failure, so nothing goes to CBP without a record.
export async function createHandoff(input: HandoffInput, db: AuditDb = prisma): Promise<{ submissionId: string }> {
  const submission = await db.$transaction(async (tx) => {
    const sub = await tx.aesSubmission.create({
      data: {
        nonce: input.nonce,
        shipmentId: input.shipmentId,
        fileNumber: input.fileNumber,
        srn: input.srn,
        kind: input.kind,
        action: input.action,
        environment: input.environment,
        targetUrl: input.targetUrl,
        payload: input.payload,
        payloadHash: input.payloadHash,
        lineCount: input.lineCount,
        advisories: input.advisories,
        userId: input.actor.userId,
        userEmail: input.actor.email,
        userName: input.actor.name,
      },
      select: { id: true },
    });
    await tx.aesAuditEvent.create({
      data: {
        type: input.kind === "FILING" ? "FILING_HANDOFF" : "INQUIRY_HANDOFF",
        submissionId: sub.id,
        shipmentId: input.shipmentId,
        fileNumber: input.fileNumber,
        environment: input.environment,
        actorType: "USER",
        userId: input.actor.userId,
        userEmail: input.actor.email,
        userName: input.actor.name,
        summary: input.summary,
        detail: input.detail,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
    return sub;
  });
  mirror({ type: input.kind === "FILING" ? "FILING_HANDOFF" : "INQUIRY_HANDOFF", submissionId: submission.id, fileNumber: input.fileNumber, environment: input.environment, userId: input.actor.userId, payloadHash: input.payloadHash });
  return { submissionId: submission.id };
}

export type ReturnOutcome = "success" | "failure" | "status";

export interface ReturnInput {
  nonce: string;
  outcome: ReturnOutcome;
  fileNumber: string;
  method: string;
  params: Array<[string, string]>;
  meta: RequestMeta;
  now?: Date;
}

export interface ReturnResult {
  // Return matches a filing we sent.
  matched: boolean;
  // First return for that filing.
  first: boolean;
  // Too many returns, not saved.
  capped: boolean;
  submissionId: string | null;
}

function paramValue(params: Array<[string, string]>, name: string): string | undefined {
  return params.find(([k]) => k.toUpperCase() === name)?.[1];
}

const OUTCOME_TO_STORED: Record<ReturnOutcome, AesSubmissionOutcome> = { success: "SUCCESS", failure: "FAILURE", status: "STATUS" };

// CBP return (public route). Saved only if it matches a filing we sent. Never throws.
export async function recordReturn(input: ReturnInput, db: AuditDb = prisma): Promise<ReturnResult> {
  const none: ReturnResult = { matched: false, first: false, capped: false, submissionId: null };
  const ipHash = input.meta.ip ? sha256(input.meta.ip).slice(0, 12) : null;
  if (!NONCE_PATTERN.test(input.nonce)) {
    mirror({ type: "unmatched-return", reason: "bad-nonce", outcome: input.outcome, fileNumber: input.fileNumber, ipHash });
    return none;
  }
  try {
    const sub = await db.aesSubmission.findUnique({
      where: { nonce: input.nonce },
      select: { id: true, fileNumber: true, kind: true, srn: true, shipmentId: true, environment: true },
    });
    const kindFits = !!sub && (input.outcome === "status" ? sub.kind === "INQUIRY" : sub.kind === "FILING");
    if (!sub || sub.fileNumber !== input.fileNumber || !kindFits) {
      mirror({ type: "unmatched-return", reason: sub ? "mismatch" : "unknown-nonce", outcome: input.outcome, fileNumber: input.fileNumber, ipHash });
      return none;
    }

    const bumped = await db.aesSubmission.updateMany({
      where: { id: sub.id, returnCount: { lt: MAX_RETURNS_PER_SUBMISSION } },
      data: { returnCount: { increment: 1 } },
    });
    if (bumped.count === 0) {
      mirror({ type: "return-capped", submissionId: sub.id, fileNumber: sub.fileNumber, outcome: input.outcome, ipHash });
      return { matched: true, first: false, capped: true, submissionId: sub.id };
    }

    const returnedSrn = paramValue(input.params, "SRN")?.trim();
    const itnRaw = paramValue(input.params, "ITN")?.trim().toUpperCase();
    // CBP status text (max 200 chars).
    const sta = paramValue(input.params, "STA")?.trim().slice(0, 200);
    const itnFormatOk = !!itnRaw && ITN_PATTERN.test(itnRaw);
    const checks = {
      srnReturned: returnedSrn ?? null,
      srnMatches: returnedSrn === undefined ? null : returnedSrn.toUpperCase() === sub.srn.toUpperCase(),
      itnReturned: itnRaw ?? null,
      itnFormatOk: itnRaw === undefined ? null : itnFormatOk,
      sta: sta ?? null,
    };

    const now = input.now ?? new Date();
    const set = await db.aesSubmission.updateMany({
      where: { id: sub.id, outcome: "PENDING" },
      data: {
        outcome: OUTCOME_TO_STORED[input.outcome],
        returnedAt: now,
        itnReported: itnFormatOk ? itnRaw : null,
        staReported: sta ?? null,
      },
    });
    const first = set.count === 1;
    const type: AesAuditEventType = first ? "CBP_RETURN" : "CBP_RETURN_REPEAT";
    const summary = `CBP ${input.outcome} return${itnFormatOk ? ` (ITN ${itnRaw})` : ""}${sta ? ` status ${sta}` : ""}${first ? "" : " — repeat"}`;

    await db.aesAuditEvent.create({
      data: {
        type,
        submissionId: sub.id,
        shipmentId: sub.shipmentId,
        fileNumber: sub.fileNumber,
        environment: sub.environment,
        actorType: "CBP",
        summary,
        detail: {
          outcome: input.outcome,
          method: input.method,
          params: input.params.map(([k, v]) => [k, v]),
          refererHost: input.meta.refererHost,
          checks,
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
    mirror({ type, submissionId: sub.id, fileNumber: sub.fileNumber, outcome: input.outcome, checks });
    return { matched: true, first, capped: false, submissionId: sub.id };
  } catch (err) {
    console.error("[aes-audit] failed to record CBP return", input.fileNumber, err);
    return none;
  }
}

// ---- Readers (staff pages only) ----

export interface SubmissionView {
  id: string;
  nonce: string;
  kind: AesSubmissionKind;
  action: string | null;
  environment: string;
  targetUrl: string;
  srn: string;
  payload: Record<string, string>;
  payloadHash: string;
  lineCount: number;
  userName: string;
  userEmail: string;
  outcome: AesSubmissionOutcome;
  itnReported: string | null;
  staReported: string | null;
  returnedAt: string | null;
  returnCount: number;
  createdAt: string;
  // Pending for over 24 hours.
  noReturn: boolean;
}

export interface EventView {
  id: string;
  type: AesAuditEventType;
  submissionId: string | null;
  fileNumber: string;
  environment: string;
  actorType: string;
  userName: string | null;
  userEmail: string | null;
  summary: string;
  detail: unknown;
  ip: string | null;
  createdAt: string;
}

type SubmissionRow = Awaited<ReturnType<PrismaClient["aesSubmission"]["findMany"]>>[number];
type EventRow = Awaited<ReturnType<PrismaClient["aesAuditEvent"]["findMany"]>>[number];

function toPayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

export function toSubmissionView(row: SubmissionRow, now: Date = new Date()): SubmissionView {
  return {
    id: row.id,
    nonce: row.nonce,
    kind: row.kind,
    action: row.action,
    environment: row.environment,
    targetUrl: row.targetUrl,
    srn: row.srn,
    payload: toPayload(row.payload),
    payloadHash: row.payloadHash,
    lineCount: row.lineCount,
    userName: row.userName,
    userEmail: row.userEmail,
    outcome: row.outcome,
    itnReported: row.itnReported,
    staReported: row.staReported,
    returnedAt: row.returnedAt ? row.returnedAt.toISOString() : null,
    returnCount: row.returnCount,
    createdAt: row.createdAt.toISOString(),
    noReturn: row.outcome === "PENDING" && now.getTime() - row.createdAt.getTime() > NO_RETURN_AFTER_MS,
  };
}

export function toEventView(row: EventRow): EventView {
  return {
    id: row.id,
    type: row.type,
    submissionId: row.submissionId,
    fileNumber: row.fileNumber,
    environment: row.environment,
    actorType: row.actorType,
    userName: row.userName,
    userEmail: row.userEmail,
    summary: row.summary,
    detail: row.detail,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

// Audit history for one shipment, newest first. Throws on DB error.
export async function getShipmentAudit(
  fileNumber: string,
  db: Pick<PrismaClient, "aesSubmission" | "aesAuditEvent"> = prisma,
  now: Date = new Date()
): Promise<{ submissions: SubmissionView[]; events: EventView[] }> {
  const [subs, events] = await Promise.all([
    db.aesSubmission.findMany({ where: { fileNumber }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.aesAuditEvent.findMany({ where: { fileNumber }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  return { submissions: subs.map((s) => toSubmissionView(s, now)), events: events.map(toEventView) };
}

export const AUDIT_EVENT_TYPES: AesAuditEventType[] = [
  "FILING_HANDOFF",
  "INQUIRY_HANDOFF",
  "HANDOFF_BLOCKED",
  "HANDOFF_STALE",
  "CBP_RETURN",
  "CBP_RETURN_REPEAT",
  "DETAILS_SAVED",
  "ITN_CONFIRMED",
  "ITN_ENTERED_MANUALLY",
  "MARKED_EXEMPT",
];

export interface AuditFilters {
  fileNumber?: string;
  type?: AesAuditEventType;
  environment?: string;
  userEmail?: string;
  from?: Date;
  // Up to, not including.
  to?: Date;
}

// Reads the filters from the URL; ignores bad values.
export function parseAuditFilters(query: Record<string, string | string[] | undefined>): AuditFilters {
  const str = (k: string) => {
    const v = query[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const filters: AuditFilters = {};
  const fileNumber = str("fileNumber");
  if (/^[A-Za-z0-9-]{1,30}$/.test(fileNumber)) filters.fileNumber = fileNumber;
  const type = str("type");
  if ((AUDIT_EVENT_TYPES as string[]).includes(type)) filters.type = type as AesAuditEventType;
  const env = str("environment");
  if (env === "cert" || env === "production") filters.environment = env;
  const user = str("user");
  if (user && user.length <= 200) filters.userEmail = user;
  const day = (k: string) => {
    const v = str(k);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const from = day("from");
  if (from) filters.from = from;
  const to = day("to");
  if (to) filters.to = new Date(to.getTime() + 24 * 60 * 60 * 1000); // include the whole end day
  return filters;
}

function whereFor(filters: AuditFilters): Prisma.AesAuditEventWhereInput {
  const where: Prisma.AesAuditEventWhereInput = {};
  if (filters.fileNumber) where.fileNumber = filters.fileNumber;
  if (filters.type) where.type = filters.type;
  if (filters.environment) where.environment = filters.environment;
  // Escape it: Mongo treats this as a regex.
  if (filters.userEmail) where.userEmail = { equals: escapeRegex(filters.userEmail), mode: "insensitive" };
  if (filters.from || filters.to) where.createdAt = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) };
  return where;
}

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_CSV_MAX_ROWS = 10000;

export async function listAuditEvents(
  filters: AuditFilters,
  page: number,
  db: Pick<PrismaClient, "aesAuditEvent"> = prisma
): Promise<{ events: EventView[]; total: number }> {
  const where = whereFor(filters);
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const [rows, total] = await Promise.all([
    db.aesAuditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (safePage - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
    db.aesAuditEvent.count({ where }),
  ]);
  return { events: rows.map(toEventView), total };
}

export async function listAuditEventsForCsv(
  filters: AuditFilters,
  db: Pick<PrismaClient, "aesAuditEvent"> = prisma
): Promise<EventView[]> {
  const rows = await db.aesAuditEvent.findMany({ where: whereFor(filters), orderBy: { createdAt: "desc" }, take: AUDIT_CSV_MAX_ROWS });
  return rows.map(toEventView);
}

// The filing a CBP return belongs to, if it is for this shipment.
export async function findSubmissionByNonce(
  fileNumber: string,
  nonce: string,
  db: Pick<PrismaClient, "aesSubmission"> = prisma,
  now: Date = new Date()
): Promise<SubmissionView | null> {
  if (!NONCE_PATTERN.test(nonce)) return null;
  const row = await db.aesSubmission.findUnique({ where: { nonce } });
  if (!row || row.fileNumber !== fileNumber) return null;
  return toSubmissionView(row, now);
}

// ---- CSV ----

// Quotes a CSV cell and blocks Excel formulas.
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function eventsToCsv(events: EventView[]): string {
  const header = ["createdAtUtc", "type", "fileNumber", "environment", "actorType", "userName", "userEmail", "summary", "submissionId", "ip", "detail"];
  const lines = [header.map(csvCell).join(",")];
  for (const e of events) {
    lines.push(
      [e.createdAt, e.type, e.fileNumber, e.environment, e.actorType, e.userName, e.userEmail, e.summary, e.submissionId, e.ip, e.detail === null || e.detail === undefined ? "" : JSON.stringify(e.detail)]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
