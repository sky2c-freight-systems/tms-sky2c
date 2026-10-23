import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, ShipmentStatus, DomesticType, IncoTerms, TypeOfService, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { dollarsToCents } from "@/lib/money";
import { autoCreateInvoiceForShipment, syncInvoiceAmountToShipment } from "@/lib/billing";
import { mapShipmentStatusToZohoStatus } from "@/lib/zohoStatusMap";
import { updateTicket } from "@/lib/zohoDeskApi";
import { recordStatusChange } from "@/lib/tracking";
import { extraFieldsToPrismaData, extraFieldsZodShape } from "@/lib/shipmentZohoSections";
import { sanitizeZohoFields } from "@/lib/shipmentLayoutFields";
import { isDispatchShipment } from "@/lib/pickupBol";
import { isAirOpsShipment } from "@/lib/hawb";

const SHIPMENT_STATUS_VALUES = Object.values(ShipmentStatus) as [ShipmentStatus, ...ShipmentStatus[]];
const DOMESTIC_TYPE_VALUES = Object.values(DomesticType) as [DomesticType, ...DomesticType[]];
const INCOTERMS_VALUES = Object.values(IncoTerms) as [IncoTerms, ...IncoTerms[]];
const TYPE_OF_SERVICE_VALUES = Object.values(TypeOfService) as [TypeOfService, ...TypeOfService[]];
const PAYMENT_METHOD_VALUES = Object.values(PaymentMethod) as [PaymentMethod, ...PaymentMethod[]];

/** Read-only DomesticWarehouseShipment lookup by fileNumber, for manually verifying Zoho sync results (and reused by the shipment edit form). Real session auth (401 on failure). */
export async function GET(_request: Request, { params }: { params: Promise<{ fileNumber: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { fileNumber } = await params;
  const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber } });
  if (!shipment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Parent/child family for the header links on the shipment page.
  const familySelect = { fileNumber: true, status: true, zohoLayoutName: true } as const;
  const [parent, children] = await Promise.all([
    shipment.parentId
      ? prisma.domesticWarehouseShipment.findUnique({ where: { id: shipment.parentId }, select: familySelect })
      : null,
    prisma.domesticWarehouseShipment.findMany({
      where: { parentId: shipment.id },
      orderBy: { createdAt: "asc" },
      select: familySelect,
    }),
  ]);

  return NextResponse.json({ data: shipment, parent, children, isDispatch: isDispatchShipment(shipment),
    isAirOps: isAirOpsShipment(shipment),
  });
}

const dollarAmount = z.union([z.string(), z.number()]).nullish();

// Every field is optional (partial update). `fileNumber` is intentionally NOT part of
// this schema — if the client includes it in the body anyway, it's silently ignored
// below rather than accepted, since fileNumber must never be editable post-creation.
const patchShipmentSchema = z.object({
  status: z.enum(SHIPMENT_STATUS_VALUES).optional(),
  domesticType: z.enum(DOMESTIC_TYPE_VALUES).optional(),
  divisionId: z.number().int().nullish(),
  busLine: z.number().int().nullish(),
  accountId: z.string().nullish(),
  shipperId: z.string().nullish(),
  consigneeId: z.string().nullish(),
  notifyPartyId: z.string().nullish(),
  soldToId: z.string().nullish(),
  shipToId: z.string().nullish(),
  carrierId: z.string().nullish(),
  placeOfReceipt: z.string().nullish(),
  origin: z.string().nullish(),
  destination: z.string().nullish(),
  country: z.string().nullish(),
  placeOfDelivery: z.string().nullish(),
  incoTerms: z.enum(INCOTERMS_VALUES).nullish(),
  proNumber: z.string().nullish(),
  bolNumber: z.string().nullish(),
  typeOfService: z.enum(TYPE_OF_SERVICE_VALUES).nullish(),
  otherReference: z.string().nullish(),
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES).nullish(),
  transitStartAt: z.string().nullish(),
  transitEndAt: z.string().nullish(),
  shipAt: z.string().nullish(),
  cutoffAt: z.string().nullish(),
  etaAt: z.string().nullish(),
  atdAt: z.string().nullish(),
  cargoDescription: z.string().nullish(),
  insurance: z.string().nullish(),
  insuranceValue: dollarAmount,
  codFee: dollarAmount,
  dryRun: z.string().nullish(),
  totalCharges: dollarAmount,
  serviceLevel: z.string().nullish(),
  ...extraFieldsZodShape,
  zohoLayoutName: z.string().nullish(),
  zohoFields: z.record(z.string(), z.unknown()).nullish(),
});

function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date value: ${value}`);
  return d;
}

/**
 * PATCH /api/shipments/[fileNumber] — partial update. Dollar fields
 * (insuranceValue/codFee/totalCharges) are accepted as strings/numbers and converted to
 * cents here, never trusting any client-side conversion. `fileNumber` itself can never
 * be changed via this route, even if present in the body — this is a deliberate fix vs.
 * anywhere the legacy app might have let the file number be edited post-creation.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ fileNumber: string }> }) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { fileNumber } = await params;

  const body = await request.json().catch(() => null);
  const parsed = patchShipmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  const update: Prisma.DomesticWarehouseShipmentUpdateInput = {};
  if (data.status !== undefined) update.status = data.status;
  if (data.domesticType !== undefined) update.domesticType = data.domesticType;
  if (data.divisionId !== undefined) update.divisionId = data.divisionId;
  if (data.busLine !== undefined) update.busLine = data.busLine;
  if (data.accountId !== undefined) update.accountId = data.accountId;
  if (data.shipperId !== undefined) update.shipperId = data.shipperId;
  if (data.consigneeId !== undefined) update.consigneeId = data.consigneeId;
  if (data.notifyPartyId !== undefined) update.notifyPartyId = data.notifyPartyId;
  if (data.soldToId !== undefined) update.soldToId = data.soldToId;
  if (data.shipToId !== undefined) update.shipToId = data.shipToId;
  if (data.carrierId !== undefined) update.carrierId = data.carrierId;
  if (data.placeOfReceipt !== undefined) update.placeOfReceipt = data.placeOfReceipt;
  if (data.origin !== undefined) update.origin = data.origin;
  if (data.destination !== undefined) update.destination = data.destination;
  if (data.country !== undefined) update.country = data.country;
  if (data.placeOfDelivery !== undefined) update.placeOfDelivery = data.placeOfDelivery;
  if (data.incoTerms !== undefined) update.incoTerms = data.incoTerms;
  if (data.proNumber !== undefined) update.proNumber = data.proNumber;
  if (data.bolNumber !== undefined) update.bolNumber = data.bolNumber;
  if (data.typeOfService !== undefined) update.typeOfService = data.typeOfService;
  if (data.otherReference !== undefined) update.otherReference = data.otherReference;
  if (data.paymentMethod !== undefined) update.paymentMethod = data.paymentMethod;
  if (data.cargoDescription !== undefined) update.cargoDescription = data.cargoDescription;
  if (data.insurance !== undefined) update.insurance = data.insurance;
  if (data.dryRun !== undefined) update.dryRun = data.dryRun;
  if (data.serviceLevel !== undefined) update.serviceLevel = data.serviceLevel;
  if (data.zohoLayoutName !== undefined) update.zohoLayoutName = data.zohoLayoutName;
  // The form always sends the whole object, so it replaces the stored one.
  if (data.zohoFields !== undefined) update.zohoFields = sanitizeZohoFields(data.zohoFields ?? {});

  try {
    if (data.transitStartAt !== undefined) update.transitStartAt = toDateOrNull(data.transitStartAt);
    if (data.transitEndAt !== undefined) update.transitEndAt = toDateOrNull(data.transitEndAt);
    if (data.shipAt !== undefined) update.shipAt = toDateOrNull(data.shipAt);
    if (data.cutoffAt !== undefined) update.cutoffAt = toDateOrNull(data.cutoffAt);
    if (data.etaAt !== undefined) update.etaAt = toDateOrNull(data.etaAt);
    if (data.atdAt !== undefined) update.atdAt = toDateOrNull(data.atdAt);
    if (data.insuranceValue !== undefined) update.insuranceValueCents = dollarsToCents(data.insuranceValue);
    if (data.codFee !== undefined) update.codFeeCents = dollarsToCents(data.codFee);
    if (data.totalCharges !== undefined) update.totalChargesCents = dollarsToCents(data.totalCharges);
    Object.assign(update, extraFieldsToPrismaData(data));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid value" }, { status: 400 });
  }

  update.updatedBy = session.userId;

  // Read the status before the write so the tracking timeline only records genuine
  // transitions — the shipments list re-submits the current status on every edit.
  const previous =
    data.status !== undefined
      ? await prisma.domesticWarehouseShipment.findUnique({
          where: { fileNumber },
          select: { status: true },
        })
      : null;

  try {
    const shipment = await prisma.domesticWarehouseShipment.update({ where: { fileNumber }, data: update });

    if (data.status !== undefined) {
      await recordStatusChange(
        shipment.id,
        shipment.fileNumber,
        previous?.status ?? null,
        shipment.status,
        "USER",
        shipment.destination ?? shipment.origin ?? null
      );
    }

    // Manually filling in the missing piece (Account or quote amount) via the edit
    // form should retroactively trigger invoice creation the same way a Zoho
    // ticket update does — see src/app/api/webhooks/zoho/ticket-updated/route.ts.
    await autoCreateInvoiceForShipment(shipment);
    if (data.totalCharges !== undefined || data.dryRun !== undefined) {
      await syncInvoiceAmountToShipment(shipment.id, {
        totalChargesCents: shipment.totalChargesCents,
        dryRun: shipment.dryRun,
      });
    }

    // Other leg of the two-way status sync: a manual status change here (e.g. the
    // shipments list page's status dropdown) is pushed back onto the originating
    // Zoho ticket, mirroring the ticket-updated webhook's Zoho -> TMS direction (see
    // src/lib/zohoStatusMap.ts). Best-effort — a shipment not linked to a ticket, or
    // a Zoho API failure, must never fail the shipment update that already succeeded.
    if (data.status !== undefined) {
      const zohoSync = await prisma.zohoSync.findFirst({ where: { fileNumber }, select: { zohoTicketId: true } });
      if (zohoSync) {
        try {
          await updateTicket(zohoSync.zohoTicketId, { status: mapShipmentStatusToZohoStatus(shipment.status) });
        } catch (err) {
          console.error(`[shipments] failed to push status back to Zoho ticket ${zohoSync.zohoTicketId}:`, err);
        }
      }
    }

    return NextResponse.json({ data: shipment });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}
