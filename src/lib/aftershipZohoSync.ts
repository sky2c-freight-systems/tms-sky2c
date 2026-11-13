import type { DomesticWarehouseShipment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isDispatchShipment } from "@/lib/pickupBol";
import { LAYOUT_GROUPS } from "@/lib/zohoLayouts";
import {
  addPrivateTicketComment,
  isAftershipZohoUpdateEnabled,
  updateTicketFieldsFromAftership,
} from "@/lib/zohoDeskApi";

/**
 * AfterShip tracking update -> the US Dispatch Team Zoho ticket whose Pro Number is the
 * tracking number. Writes two fields (pickup date + ETA, which ones depends on the ticket's
 * layout) and posts the AfterShip status as a private comment when it changes.
 * AftershipTracking remembers what was last written, so the webhook firing on every
 * checkpoint only reaches Zoho when something actually changed. Behind
 * AFTERSHIP_ZOHO_UPDATE_ENABLED: while that's off it only logs what it would do.
 */

const DISPATCH_GROUP = LAYOUT_GROUPS.find((g) => g.department === "US Dispatch Team");
const DISPATCH_LAYOUT_NAMES = DISPATCH_GROUP?.layouts.map((l) => l.name) ?? [];

/** Pickup / ETA fields per Dispatch layout; a shipment with no layout uses Dispatch to Warehouse's. */
const FIELDS_BY_LAYOUT: Record<string, { pickup: string; eta: string }> = {
  "Dispatch to Warehouse": { pickup: "cf_pickup_date", eta: "cf_eta_at_warehouse" },
  "Dispatch to Port": { pickup: "cf_pickup_date", eta: "cf_eta_for_port_drop" },
  "Warehouse to Port": { pickup: "cf_warehouse_pickup_date", eta: "cf_eta_for_port_drop" },
};

/** AfterShip sends local times without a zone; they're read as Sky2C dispatch's Pacific time, like the BOL. */
const AFTERSHIP_TIME_ZONE = process.env.BOL_TIME_ZONE || "America/Los_Angeles";

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** "0888-219312 " -> "888219312". Comparing this way tolerates leading zeros, spaces and dashes. */
export function normalizeTrackingNumber(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "").replace(/^0+/, "").toUpperCase();
}

/** Real carrier PROs are long and numeric-heavy; placeholders like "NA" / "VHAUL" never match. */
function isUsableTrackingNumber(normalized: string): boolean {
  return normalized.length >= 6 && (normalized.match(/\d/g)?.length ?? 0) >= 5;
}

/**
 * AfterShip date/time -> instant. A value with a zone is taken as is; a zoneless one
 * ("2021-01-14T00:52:00", "2022-01-04") is wall time in AFTERSHIP_TIME_ZONE (date only =
 * midnight there).
 */
export function aftershipTimeToDate(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: AFTERSHIP_TIME_ZONE,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(instant))
        .map((p) => [p.type, p.value])
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
  };
  // Two passes settle the offset across a DST change.
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

/** Courier's latest ETA: AfterShip's latest estimate (its point, else the late end of its range), else the courier's own. */
export function pickEta(msg: Obj): Date | null {
  const latest = obj(msg.latest_estimated_delivery);
  const courier = obj(msg.courier_estimated_delivery_date);
  return (
    aftershipTimeToDate(latest.datetime) ??
    aftershipTimeToDate(latest.datetime_max) ??
    aftershipTimeToDate(courier.estimated_delivery_date) ??
    aftershipTimeToDate(courier.estimated_delivery_date_max)
  );
}

/** "InTransit" -> "In Transit". */
function statusLabel(msg: Obj): string {
  return str(msg.subtag_message) || str(msg.tag).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** "2021-01-14T00:52:00" -> "14 Jan 2021 00:52", as the courier reported it. */
function checkpointTime(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months.at(Number(m[2]) - 1)} ${m[1]} ${m[4]}:${m[5]}`;
}

/** The private comment posted on a status change. */
export function buildStatusComment(msg: Obj): string {
  const checkpoints = Array.isArray(msg.checkpoints) ? msg.checkpoints : [];
  const last = obj(checkpoints.at(-1));
  const where = str(last.location) || [str(last.city), str(last.state)].filter(Boolean).join(", ");
  const when = str(last.checkpoint_time) ? checkpointTime(str(last.checkpoint_time)) : "";
  const lines = [`AfterShip update: ${statusLabel(msg)}`];
  if (str(last.message)) lines.push(str(last.message));
  if (where || when) lines.push([where, when].filter(Boolean).join(" · "));
  lines.push(`Carrier: ${str(msg.slug).toUpperCase() || "?"} · Tracking: ${str(msg.tracking_number)}`);
  return lines.join("\n");
}

interface Match {
  shipment: Pick<DomesticWarehouseShipment, "id" | "fileNumber" | "zohoTicketId" | "zohoLayoutName">;
  ticketId: string;
  ignored: string[];
}

/**
 * The Dispatch shipment whose Pro Number matches. When several do, the newest one whose
 * ticket isn't Closed wins (else the newest); the rest are only logged.
 */
async function findDispatchShipment(trackingKey: string): Promise<Match | null> {
  const rows = await prisma.domesticWarehouseShipment.findMany({
    where: {
      proNumber: { not: null },
      OR: [
        ...(DISPATCH_GROUP ? [{ zohoDepartmentId: DISPATCH_GROUP.zohoDepartmentId }] : []),
        { zohoLayoutName: { in: DISPATCH_LAYOUT_NAMES } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileNumber: true, proNumber: true, zohoTicketId: true, zohoLayoutName: true, zohoDepartmentId: true },
  });
  const candidates = rows.filter(
    (r) => isDispatchShipment(r) && normalizeTrackingNumber(r.proNumber ?? "") === trackingKey
  );
  if (candidates.length === 0) return null;

  const syncs = await prisma.zohoSync.findMany({
    where: { fileNumber: { in: candidates.map((c) => c.fileNumber) } },
    select: { fileNumber: true, zohoTicketId: true, ticketStatus: true },
  });
  const syncByFile = new Map(syncs.map((s) => [s.fileNumber, s]));
  const isOpen = (c: (typeof candidates)[number]) => syncByFile.get(c.fileNumber)?.ticketStatus?.toLowerCase() !== "closed";
  const chosen = candidates.find(isOpen) ?? candidates[0];
  const ticketId = chosen.zohoTicketId || syncByFile.get(chosen.fileNumber)?.zohoTicketId;
  if (!ticketId) return null;
  return {
    shipment: chosen,
    ticketId,
    ignored: candidates.filter((c) => c !== chosen).map((c) => c.fileNumber),
  };
}

/** Called after the AfterShip webhook has answered 200. Never throws. */
export async function syncAftershipToZoho(payload: unknown): Promise<void> {
  const msg = obj(obj(payload).msg);
  const tracking = str(msg.tracking_number);
  const tag = str(msg.tag);
  const tracePrefix = `[aftership] ${tracking || "?"} (${tag || "no status"})`;
  try {
    const key = normalizeTrackingNumber(tracking);
    if (!isUsableTrackingNumber(key)) {
      console.info(`${tracePrefix}: no usable tracking number, skipped`);
      return;
    }
    const match = await findDispatchShipment(key);
    if (!match) {
      console.info(`${tracePrefix}: no Dispatch ticket with this Pro Number, skipped`);
      return;
    }
    const { shipment, ticketId, ignored } = match;
    if (ignored.length) console.info(`${tracePrefix}: Pro Number also on ${ignored.join(", ")}; updating ${shipment.fileNumber} only`);

    const fields = FIELDS_BY_LAYOUT[shipment.zohoLayoutName ?? ""] ?? FIELDS_BY_LAYOUT["Dispatch to Warehouse"];
    const record = await prisma.aftershipTracking.findUnique({ where: { trackingNumber: key } });

    const pickup = aftershipTimeToDate(msg.shipment_pickup_date);
    const eta = pickEta(msg);
    const cf: Record<string, string> = {};
    if (pickup && pickup.getTime() !== record?.lastPickupAt?.getTime()) cf[fields.pickup] = pickup.toISOString();
    if (eta && eta.getTime() !== record?.lastEtaAt?.getTime()) cf[fields.eta] = eta.toISOString();
    const comment = tag && tag !== record?.lastTag ? buildStatusComment(msg) : null;

    const target = `${shipment.fileNumber} / ticket ${ticketId}`;
    if (Object.keys(cf).length === 0 && !comment) {
      console.info(`${tracePrefix}: ${target} unchanged`);
      return;
    }
    if (!isAftershipZohoUpdateEnabled()) {
      console.info(
        `${tracePrefix}: dry run (AFTERSHIP_ZOHO_UPDATE_ENABLED != "true") — would update ${target}: ` +
          `${JSON.stringify(cf)}${comment ? `, comment "${statusLabel(msg)}"` : ""}`
      );
      return;
    }

    const base = { shipmentId: shipment.id, zohoTicketId: ticketId };
    if (Object.keys(cf).length) {
      try {
        await updateTicketFieldsFromAftership(ticketId, cf);
        const saved = { ...base, ...(pickup ? { lastPickupAt: pickup } : {}), ...(eta ? { lastEtaAt: eta } : {}) };
        await prisma.aftershipTracking.upsert({
          where: { trackingNumber: key },
          create: { trackingNumber: key, ...saved },
          update: saved,
        });
        console.info(`${tracePrefix}: updated ${target}: ${Object.keys(cf).join(", ")}`);
      } catch (err) {
        console.error(`${tracePrefix}: field update failed for ${target}:`, err instanceof Error ? err.message : err);
      }
    }
    if (comment) {
      try {
        await addPrivateTicketComment(ticketId, comment);
        await prisma.aftershipTracking.upsert({
          where: { trackingNumber: key },
          create: { trackingNumber: key, ...base, lastTag: tag },
          update: { ...base, lastTag: tag },
        });
        console.info(`${tracePrefix}: private comment added on ${target}`);
      } catch (err) {
        console.error(`${tracePrefix}: comment failed for ${target}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error(`${tracePrefix}: sync failed:`, err instanceof Error ? err.message : err);
  }
}
