import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listPickupBols } from "@/lib/pickupBol";
import { isValidWidgetApiKey } from "@/lib/zohoWidgetAuth";
import { findShipmentByTicketNumber } from "@/lib/zohoWidgetShipment";

/**
 * GET /api/zoho/bols?ticketNumber= — the Zoho Desk widget's list of a ticket's Pickup BOLs,
 * newest first: the same list as the shipment page's "Pickup Bill of Lading" card. Read only.
 * Auth is the X-API-Key header (ZOHO_WIDGET_API_KEY); errors are JSON { error }.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  if (!isValidWidgetApiKey(request)) return error("Invalid API key", 401);
  const ticketNumber = new URL(request.url).searchParams.get("ticketNumber")?.trim() ?? "";
  if (!ticketNumber) return error("ticketNumber is required", 400);

  try {
    const shipment = await findShipmentByTicketNumber(ticketNumber);
    if (!shipment) return error(`No shipment for ticket ${ticketNumber}`, 404);

    const bols = await listPickupBols(shipment.id);
    // listPickupBols doesn't return who generated each BOL; read that separately for the same rows.
    const creators = bols.length
      ? await prisma.generatedDocument.findMany({
          where: { id: { in: bols.map((b) => b.id) } },
          select: { id: true, createdBy: true },
        })
      : [];
    const creatorByBol = new Map(creators.map((c) => [c.id, c.createdBy]));
    const userIds = [...new Set(creators.map((c) => c.createdBy).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : [];
    const nameByUser = new Map(users.map((u) => [u.id, u.displayName]));

    return NextResponse.json(
      {
        fileNumber: shipment.fileNumber,
        bols: bols.map((b) => {
          const userId = creatorByBol.get(b.id);
          return {
            bolId: b.id,
            fileName: b.fileName,
            source: b.source,
            createdAt: b.createdAt.toISOString(),
            createdBy: (userId && nameByUser.get(userId)) || null,
          };
        }),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error(`[zoho-widget] BOL list failed for ticket ${ticketNumber}:`, err instanceof Error ? err.message : err);
    return error("Failed to load BOLs", 500);
  }
}

function methodNotAllowed() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
