import type { DomesticWarehouseShipment, GeneratedDocumentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LAYOUT_GROUPS } from "@/lib/zohoLayouts";
import { buildPickupBolData, hashPickupBolData, missingPickupBolFields } from "@/lib/pdf/pickupBolData";
import { pickupBol } from "@/lib/pdf/templates/pickupBol";
import { renderHtmlToPdf } from "@/lib/pdf/renderToPdf";

/**
 * Pickup Bill of Lading for Dispatch shipments: generated on demand ("Generate BOL") or
 * automatically on Zoho ticket create/update while the app-wide AUTO_PICKUP_BOL_KEY setting
 * is on. Every PDF is kept in GeneratedDocument (TMS only — nothing is sent to Zoho).
 */

export const PICKUP_BOL_DOC_TYPE = "pickup-bol";
const AUTO_PICKUP_BOL_KEY = "autoPickupBol";

const DISPATCH_GROUP = LAYOUT_GROUPS.find((g) => g.department === "US Dispatch Team");
const DISPATCH_LAYOUT_NAMES = new Set(DISPATCH_GROUP?.layouts.map((l) => l.name) ?? []);

/** True for shipments from the US Dispatch Team department (by department, else layout). */
export function isDispatchShipment(s: Pick<DomesticWarehouseShipment, "zohoDepartmentId" | "zohoLayoutName">): boolean {
  if (DISPATCH_GROUP && s.zohoDepartmentId === DISPATCH_GROUP.zohoDepartmentId) return true;
  return !!s.zohoLayoutName && DISPATCH_LAYOUT_NAMES.has(s.zohoLayoutName);
}

export async function getAutoPickupBolEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_PICKUP_BOL_KEY } });
  return row?.value === true;
}

export async function setAutoPickupBolEnabled(enabled: boolean, userId?: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: AUTO_PICKUP_BOL_KEY },
    create: { key: AUTO_PICKUP_BOL_KEY, value: enabled, updatedBy: userId },
    update: { value: enabled, updatedBy: userId },
  });
}

/** Thrown by generatePickupBol when fields the BOL needs are empty. */
export class MissingBolFieldsError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Please fill: ${missing.join(", ")}`);
    this.name = "MissingBolFieldsError";
  }
}

async function carrierClientName(shipment: DomesticWarehouseShipment): Promise<string | null> {
  if (!shipment.carrierId) return null;
  const carrier = await prisma.client.findUnique({ where: { id: shipment.carrierId }, select: { name: true } });
  return carrier?.name ?? null;
}

async function renderForShipment(shipment: DomesticWarehouseShipment) {
  const carrierName = await carrierClientName(shipment);
  const data = buildPickupBolData(shipment, carrierName);
  return { data, hash: hashPickupBolData(data), missing: missingPickupBolFields(shipment, carrierName) };
}

/** Labels of the fields still empty that the BOL needs (empty when it can be generated). */
export async function getMissingPickupBolFields(shipment: DomesticWarehouseShipment): Promise<string[]> {
  return missingPickupBolFields(shipment, await carrierClientName(shipment));
}

function fileNameFor(reference: string): string {
  // yyyymmdd-hhmmss (UTC); seconds keep two BOLs generated in the same minute apart.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `BOL_${reference.replace(/[^\w.-]+/g, "_")}_${stamp}.pdf`;
}

async function saveBol(
  shipment: DomesticWarehouseShipment,
  source: GeneratedDocumentSource,
  rendered: Awaited<ReturnType<typeof renderForShipment>>,
  userId?: string
) {
  const pdf = await renderHtmlToPdf(pickupBol(rendered.data));
  return prisma.generatedDocument.create({
    data: {
      shipmentId: shipment.id,
      fileNumber: shipment.fileNumber,
      docType: PICKUP_BOL_DOC_TYPE,
      fileName: fileNameFor(rendered.data.reference),
      pdf: new Uint8Array(pdf),
      dataHash: rendered.hash,
      source,
      createdBy: userId,
    },
    select: { id: true, fileName: true, source: true, createdAt: true },
  });
}

/**
 * "Generate BOL" button: renders and saves a new version. Throws MissingBolFieldsError
 * when a required field is empty — a BOL is never issued with blanks.
 */
export async function generatePickupBol(shipment: DomesticWarehouseShipment, userId?: string) {
  const rendered = await renderForShipment(shipment);
  if (rendered.missing.length) throw new MissingBolFieldsError(rendered.missing);
  return saveBol(shipment, "MANUAL", rendered, userId);
}

/**
 * Called after a Zoho webhook creates/updates a shipment. No-op unless the setting is on and
 * this is a Dispatch shipment; waits until every required field is filled, and skips when
 * the BOL's data is unchanged since the latest version, so ordinary ticket updates don't
 * pile up identical PDFs. Never throws.
 */
export async function autoGeneratePickupBol(shipmentId: string): Promise<void> {
  try {
    if (!(await getAutoPickupBolEnabled())) return;
    const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment || !isDispatchShipment(shipment)) return;

    const rendered = await renderForShipment(shipment);
    if (rendered.missing.length) return;
    const latest = await prisma.generatedDocument.findFirst({
      where: { shipmentId, docType: PICKUP_BOL_DOC_TYPE },
      orderBy: { createdAt: "desc" },
      select: { dataHash: true },
    });
    if (latest?.dataHash === rendered.hash) return;

    await saveBol(shipment, "AUTO", rendered);
  } catch (err) {
    console.error(`[pickupBol] auto-generation failed for shipment ${shipmentId}:`, err);
  }
}

export async function listPickupBols(shipmentId: string) {
  return prisma.generatedDocument.findMany({
    where: { shipmentId, docType: PICKUP_BOL_DOC_TYPE },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, source: true, createdAt: true },
  });
}
