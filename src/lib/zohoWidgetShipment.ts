import type { DomesticWarehouseShipment } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The shipment for a Zoho ticket number, for the read-only widget routes (GET /api/zoho/bols,
 * GET /api/zoho/bol/[bolId]). Exact ticket-number match via the Zoho sync log, newest row
 * first — the same lookup POST /api/zoho/bol does, without its ticketId fallback.
 */
export async function findShipmentByTicketNumber(ticketNumber: string): Promise<DomesticWarehouseShipment | null> {
  const sync = await prisma.zohoSync.findFirst({
    where: { zohoTicketNumber: ticketNumber, fileNumber: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { fileNumber: true },
  });
  if (!sync?.fileNumber) return null;
  return prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber: sync.fileNumber } });
}
