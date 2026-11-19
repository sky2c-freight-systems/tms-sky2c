import type { DomesticWarehouseShipment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LAYOUT_GROUPS } from "@/lib/zohoLayouts";
import { buildHawbData } from "@/lib/pdf/hawbData";
import { hawb } from "@/lib/pdf/templates/hawb";
import { renderHtmlToPdf } from "@/lib/pdf/renderToPdf";

/**
 * House Air Waybill for Air Ops (parent) shipments, generated on demand ("Generate HAWB").
 * Kept in GeneratedDocument like the Pickup BOL (src/lib/pickupBol.ts) — TMS only.
 */

export const HAWB_DOC_TYPE = "hawb";

const AIR_OPS_GROUP = LAYOUT_GROUPS.find((g) => g.department === "Air Ops");
const AIR_OPS_LAYOUT_NAMES = new Set(AIR_OPS_GROUP?.layouts.map((l) => l.name) ?? []);

/** True for shipments from the Air Ops department (by department, else layout). */
export function isAirOpsShipment(s: Pick<DomesticWarehouseShipment, "zohoDepartmentId" | "zohoLayoutName">): boolean {
  if (AIR_OPS_GROUP && s.zohoDepartmentId === AIR_OPS_GROUP.zohoDepartmentId) return true;
  return !!s.zohoLayoutName && AIR_OPS_LAYOUT_NAMES.has(s.zohoLayoutName);
}

/** Renders and saves a new HAWB version; `signedBy` prints as the issuing agent's signature. */
export async function generateHawb(shipment: DomesticWarehouseShipment, signedBy: string | null, userId?: string) {
  const ids = [shipment.shipperId, shipment.consigneeId].filter((id): id is string => !!id);
  const clients = ids.length
    ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, clientId: true } })
    : [];
  const clientIdOf = (id: string | null) => clients.find((c) => c.id === id)?.clientId ?? null;
  const data = buildHawbData(shipment, signedBy, {
    shipperCode: clientIdOf(shipment.shipperId),
    consigneeCode: clientIdOf(shipment.consigneeId),
  });
  const pdf = await renderHtmlToPdf(hawb(data));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return prisma.generatedDocument.create({
    data: {
      shipmentId: shipment.id,
      fileNumber: shipment.fileNumber,
      docType: HAWB_DOC_TYPE,
      fileName: `HAWB_${data.hawbNumber.replace(/[^\w.-]+/g, "_")}_${stamp}.pdf`,
      pdf: new Uint8Array(pdf),
      dataHash: "",
      source: "MANUAL",
      createdBy: userId,
    },
    select: { id: true, fileName: true, source: true, createdAt: true },
  });
}

export async function listHawbs(shipmentId: string) {
  return prisma.generatedDocument.findMany({
    where: { shipmentId, docType: HAWB_DOC_TYPE },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, source: true, createdAt: true },
  });
}
