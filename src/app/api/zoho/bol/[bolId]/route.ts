import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PICKUP_BOL_DOC_TYPE } from "@/lib/pickupBol";
import { isValidWidgetApiKey } from "@/lib/zohoWidgetAuth";
import { findShipmentByTicketNumber } from "@/lib/zohoWidgetShipment";

/**
 * GET /api/zoho/bol/[bolId]?ticketNumber= — one existing Pickup BOL as base64 JSON for the
 * Zoho Desk widget. Read only. The BOL must belong to that ticket's shipment, else 404.
 * Auth is the X-API-Key header (ZOHO_WIDGET_API_KEY); errors are JSON { error }.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET(request: Request, { params }: { params: Promise<{ bolId: string }> }) {
  if (!isValidWidgetApiKey(request)) return error("Invalid API key", 401);
  const ticketNumber = new URL(request.url).searchParams.get("ticketNumber")?.trim() ?? "";
  if (!ticketNumber) return error("ticketNumber is required", 400);
  const { bolId } = await params;
  if (!/^[0-9a-f]{24}$/i.test(bolId)) return error("Not found", 404);

  try {
    const shipment = await findShipmentByTicketNumber(ticketNumber);
    if (!shipment) return error("Not found", 404);
    const doc = await prisma.generatedDocument.findFirst({
      where: { id: bolId, shipmentId: shipment.id, docType: PICKUP_BOL_DOC_TYPE },
      select: { fileName: true, pdf: true },
    });
    if (!doc) return error("Not found", 404);
    return NextResponse.json(
      { fileName: doc.fileName, pdfBase64: Buffer.from(doc.pdf).toString("base64") },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error(`[zoho-widget] BOL read failed for ticket ${ticketNumber}:`, err instanceof Error ? err.message : err);
    return error("Failed to load BOL", 500);
  }
}

function methodNotAllowed() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
