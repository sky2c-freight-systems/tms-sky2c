import { NextResponse } from "next/server";
import type { DomesticWarehouseShipment, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findOrCreateClient } from "@/lib/clientService";
import { MissingBolFieldsError, generatePickupBol, isDispatchShipment } from "@/lib/pickupBol";
import { zohoCfToSectionData } from "@/lib/shipmentZohoSections";
import { asZohoFields, zohoCfToLayoutFields } from "@/lib/shipmentLayoutFields";
import { isValidWidgetApiKey } from "@/lib/zohoWidgetAuth";

/**
 * POST /api/zoho/bol — the Zoho Desk widget's "Print BOL": saves the ticket's BOL fields
 * into the shipment (same cf_* mapping as the ticket-updated webhook), generates a Pickup BOL
 * with the same generator as the TMS "Generate BOL" button, and returns the PDF as base64.
 * Auth is the X-API-Key header (ZOHO_WIDGET_API_KEY), not a session. Nothing is written to
 * Zoho — the widget attaches the PDF itself. Every reply is JSON { error } on failure, with
 * a message the widget shows to the agent as is.
 */

/** The BOL fields the widget may send; anything else is rejected. */
const WIDGET_FIELDS = new Set([
  "cf_ref_number",
  "cf_carrier_picklist",
  "cf_carrier",
  "cf_pickup_location",
  "cf_preferred_pickup_date",
  "cf_dock_hours",
  "cf_contact_details",
  "cf_pickup_instructions",
  "cf_warehouse_location",
  "cf_warehouse_pickup_instructions",
  "cf_port_drop_location",
  "cf_variable_2",
  "cf_commodity_detail",
  "cf_gross_weight",
  "cf_pallets_x_dimensions",
  "cf_stackable_and_turnable",
]);

class BadRequestError extends Error {}

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Body `fields` -> cf record of the non-empty values. Empty values are dropped rather than
 * cleared (the widget only sends what's filled), and values the webhook mapping would
 * silently turn into null (bad numbers / dates) are rejected up front instead.
 */
function parseFields(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new BadRequestError("fields must be an object");
  const cf: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!WIDGET_FIELDS.has(key)) throw new BadRequestError(`Unknown field: ${key}`);
    const value = asTrimmedString(raw);
    if (value === null) throw new BadRequestError(`${key} must be text`);
    if (value !== "") cf[key] = value;
  }
  if (cf.cf_gross_weight !== undefined && Number.isNaN(Number(cf.cf_gross_weight.replace(/,/g, "")))) {
    throw new BadRequestError("cf_gross_weight must be a number");
  }
  if (cf.cf_preferred_pickup_date !== undefined && Number.isNaN(new Date(cf.cf_preferred_pickup_date).getTime())) {
    throw new BadRequestError("cf_preferred_pickup_date must be a date (YYYY-MM-DD or ISO date-time)");
  }
  return cf;
}

/** Exact ticket-number match via the Zoho sync log, else the ticket id. */
async function findShipment(ticketNumber: string, ticketId: string | null): Promise<DomesticWarehouseShipment | null> {
  const sync = await prisma.zohoSync.findFirst({
    where: { zohoTicketNumber: ticketNumber, fileNumber: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { fileNumber: true },
  });
  if (sync?.fileNumber) {
    const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber: sync.fileNumber } });
    if (shipment) return shipment;
  }
  if (!ticketId) return null;
  return prisma.domesticWarehouseShipment.findFirst({ where: { zohoTicketId: ticketId } });
}

/** Saves the widget's fields with the same mapping the ticket-updated webhook uses. */
async function saveFields(shipment: DomesticWarehouseShipment, cf: Record<string, string>) {
  if (Object.keys(cf).length === 0) return shipment;
  const data: Prisma.DomesticWarehouseShipmentUpdateInput = {
    ...zohoCfToSectionData(cf),
    zohoFields: { ...asZohoFields(shipment.zohoFields), ...zohoCfToLayoutFields(cf) },
  };
  if (cf.cf_commodity_detail !== undefined) data.cargoDescription = cf.cf_commodity_detail;
  if (cf.cf_carrier !== undefined) {
    const carrier = await findOrCreateClient({ name: cf.cf_carrier, role: "CARRIER" });
    data.carrierId = carrier.id;
  }
  return prisma.domesticWarehouseShipment.update({ where: { id: shipment.id }, data });
}

export async function POST(request: Request) {
  if (!isValidWidgetApiKey(request)) return error("Invalid API key", 401);

  let ticketNumber = "";
  try {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return error("Request body must be JSON", 400);
    }

    ticketNumber = asTrimmedString(body.ticketNumber) ?? "";
    if (!ticketNumber) return error("ticketNumber is required", 400);
    const ticketId = asTrimmedString(body.ticketId) || null;

    let cf: Record<string, string>;
    try {
      cf = parseFields(body.fields);
    } catch (err) {
      if (err instanceof BadRequestError) return error(err.message, 400);
      throw err;
    }

    const shipment = await findShipment(ticketNumber, ticketId);
    if (!shipment) return error(`No shipment found for ticket ${ticketNumber}`, 404);
    if (!isDispatchShipment(shipment)) return error("BOL generation is only for Dispatch tickets", 400);

    const updated = await saveFields(shipment, cf);

    let doc: Awaited<ReturnType<typeof generatePickupBol>>;
    try {
      doc = await generatePickupBol(updated);
    } catch (err) {
      if (err instanceof MissingBolFieldsError) return error(err.message, 422);
      throw err;
    }

    const stored = await prisma.generatedDocument.findUnique({ where: { id: doc.id }, select: { pdf: true } });
    if (!stored) throw new Error(`generated BOL ${doc.id} not found`);

    return NextResponse.json({
      bolId: doc.id,
      fileName: doc.fileName,
      createdAt: doc.createdAt.toISOString(),
      pdfBase64: Buffer.from(stored.pdf).toString("base64"),
    });
  } catch (err) {
    console.error(`[zoho-bol] failed for ticket ${ticketNumber || "?"}:`, err instanceof Error ? err.message : err);
    return error("Failed to generate BOL", 500);
  }
}

function methodNotAllowed() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
