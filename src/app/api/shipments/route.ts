import { NextResponse } from "next/server";
import { z } from "zod";
import { DomesticType, ShipmentStatus, IncoTerms, TypeOfService, PaymentMethod, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { generateShipmentFileNumber } from "@/lib/numbering";
import { ZOHO_DIVISION_ID, ZOHO_BUS_LINE } from "@/lib/zohoShipmentSync";
import { dollarsToCents } from "@/lib/money";
import { autoCreateInvoiceForShipment, computeShipmentTotalChargesCents } from "@/lib/billing";
import { buildZohoTicketUrl } from "@/lib/zohoTicketUrl";
import { sendOrderConfirmationEmail } from "@/lib/orderConfirmationEmail";
import { extraFieldsToPrismaData, extraFieldsZodShape } from "@/lib/shipmentZohoSections";
import { asZohoFields, sanitizeZohoFields } from "@/lib/shipmentLayoutFields";
import { escapeRegex } from "@/lib/mongoText";

const DOMESTIC_TYPE_VALUES = Object.values(DomesticType) as [DomesticType, ...DomesticType[]];
const SHIPMENT_STATUS_VALUES = Object.values(ShipmentStatus) as [ShipmentStatus, ...ShipmentStatus[]];
const INCOTERMS_VALUES = Object.values(IncoTerms) as [IncoTerms, ...IncoTerms[]];
const TYPE_OF_SERVICE_VALUES = Object.values(TypeOfService) as [TypeOfService, ...TypeOfService[]];
const PAYMENT_METHOD_VALUES = Object.values(PaymentMethod) as [PaymentMethod, ...PaymentMethod[]];

function isDomesticType(value: string | null): value is DomesticType {
  return !!value && (DOMESTIC_TYPE_VALUES as string[]).includes(value);
}

function isShipmentStatus(value: string | null): value is ShipmentStatus {
  return !!value && (SHIPMENT_STATUS_VALUES as string[]).includes(value);
}

/**
 * GET /api/shipments?status=&domesticType=&q=&page=&pageSize=
 * List for the /shipments table and the "copy from an existing shipment" search on the
 * new-shipment flow. shipperId/consigneeId are plain ObjectId scalars (not Prisma
 * relations — see prisma/schema.prisma header comment), so shipper/consignee display
 * names are resolved here via a single batched Client lookup rather than N+1 queries.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const domesticTypeParam = searchParams.get("domesticType");
  const q = searchParams.get("q")?.trim() || undefined;
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(1, Number(searchParams.get("pageSize") ?? "50") || 50));

  const where: Prisma.DomesticWarehouseShipmentWhereInput = {};
  if (isShipmentStatus(statusParam)) where.status = statusParam;
  if (isDomesticType(domesticTypeParam)) where.domesticType = domesticTypeParam;
  if (q) {
    // ZohoSync links to a shipment only by the fileNumber string (no real relation — see
    // schema header comment), so a ticket-number/id match has to be resolved as a
    // separate lookup first, then folded into the same OR as a fileNumber-in-list clause.
    const matchingSyncRows = await prisma.zohoSync.findMany({
      where: {
        fileNumber: { not: null },
        OR: [
          { zohoTicketNumber: { contains: escapeRegex(q), mode: "insensitive" } },
          { zohoTicketId: { contains: escapeRegex(q), mode: "insensitive" } },
        ],
      },
      select: { fileNumber: true },
    });
    const matchingFileNumbers = matchingSyncRows.map((r) => r.fileNumber as string);

    where.OR = [
      { fileNumber: { contains: escapeRegex(q), mode: "insensitive" } },
      { origin: { contains: escapeRegex(q), mode: "insensitive" } },
      { destination: { contains: escapeRegex(q), mode: "insensitive" } },
      ...(matchingFileNumbers.length ? [{ fileNumber: { in: matchingFileNumbers } }] : []),
    ];
  }

  // The table lists top-level shipments only, each with its child shipments nested under
  // it. A filter that matches a child brings in its parent, so the child stays findable.
  const isTopLevel: Prisma.DomesticWarehouseShipmentWhereInput = {
    OR: [{ parentId: null }, { parentId: { isSet: false } }],
  };
  let topLevelWhere: Prisma.DomesticWarehouseShipmentWhereInput = { AND: [where, isTopLevel] };
  if (Object.keys(where).length > 0) {
    const matchingChildren = await prisma.domesticWarehouseShipment.findMany({
      where: { AND: [where, { parentId: { not: null } }] },
      select: { parentId: true },
    });
    const parentIds = [...new Set(matchingChildren.map((c) => c.parentId as string))];
    if (parentIds.length) {
      topLevelWhere = { AND: [isTopLevel, { OR: [where, { id: { in: parentIds } }] }] };
    }
  }

  const [parents, total] = await Promise.all([
    prisma.domesticWarehouseShipment.findMany({
      where: topLevelWhere,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.domesticWarehouseShipment.count({ where: topLevelWhere }),
  ]);
  const children = parents.length
    ? await prisma.domesticWarehouseShipment.findMany({
        where: { parentId: { in: parents.map((p) => p.id) } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const items = [...parents, ...children];

  const clientIds = new Set<string>();
  for (const s of items) {
    if (s.shipperId) clientIds.add(s.shipperId);
    if (s.consigneeId) clientIds.add(s.consigneeId);
    if (s.accountId) clientIds.add(s.accountId);
  }
  const clients = clientIds.size
    ? await prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  const fileNumbers = items.map((s) => s.fileNumber);
  const zohoSyncRows = fileNumbers.length
    ? await prisma.zohoSync.findMany({
        where: { fileNumber: { in: fileNumbers } },
        select: { fileNumber: true, zohoTicketNumber: true, zohoTicketId: true },
      })
    : [];
  const zohoTicketByFileNumber = new Map(
    zohoSyncRows.map((z) => [z.fileNumber, z.zohoTicketNumber || z.zohoTicketId])
  );
  // Kept separate from the display label above: the label falls back to the raw ticket id
  // when there's no ticket number, but the deep link always needs the id specifically.
  const zohoTicketIdByFileNumber = new Map(zohoSyncRows.map((z) => [z.fileNumber, z.zohoTicketId]));

  const invoiceCounts = fileNumbers.length
    ? await prisma.arInvoice.groupBy({
        by: ["fileNumber"],
        where: { fileNumber: { in: fileNumbers } },
        _count: { _all: true },
      })
    : [];
  const invoiceCountByFileNumber = new Map(invoiceCounts.map((i) => [i.fileNumber, i._count._all]));

  const toRow = (s: (typeof items)[number]) => ({
    ...s,
    shipperName: s.shipperId ? (nameById.get(s.shipperId) ?? null) : null,
    consigneeName: s.consigneeId ? (nameById.get(s.consigneeId) ?? null) : null,
    accountName: s.accountId ? (nameById.get(s.accountId) ?? null) : null,
    zohoTicketNumber: zohoTicketByFileNumber.get(s.fileNumber) ?? null,
    zohoTicketUrl: buildZohoTicketUrl(zohoTicketIdByFileNumber.get(s.fileNumber)),
    invoiceCount: invoiceCountByFileNumber.get(s.fileNumber) ?? 0,
    quoteAmountCents: computeShipmentTotalChargesCents(s.dryRun, s.totalChargesCents),
    // Zoho "Ref Number" (cf_ref_number), kept in zohoFields — see src/lib/shipmentLayoutFields.ts.
    refNumber: (asZohoFields(s.zohoFields).cf_ref_number as string | null | undefined) ?? null,
  });
  const data = parents.map((p) => ({
    ...toRow(p),
    children: children.filter((c) => c.parentId === p.id).map(toRow),
  }));

  return NextResponse.json({ items: data, total, page, pageSize });
}

const dollarAmount = z.union([z.string(), z.number()]).nullish();

const createShipmentSchema = z.object({
  domesticType: z.enum(DOMESTIC_TYPE_VALUES),
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
 * POST /api/shipments — create. divisionId/busLine default to 20/65 (see
 * src/lib/zohoShipmentSync.ts, shared with the Zoho webhook). Dollar amounts (insuranceValue/codFee/totalCharges) are
 * accepted as strings and converted to cents here — the client-side conversion, if any,
 * is never trusted. status always starts SCHEDULED; createdBy/username come from the session.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createShipmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  let insuranceValueCents: number | null;
  let codFeeCents: number | null;
  let totalChargesCents: number | null;
  let transitStartAt: Date | null;
  let transitEndAt: Date | null;
  let shipAt: Date | null;
  let cutoffAt: Date | null;
  let etaAt: Date | null;
  let atdAt: Date | null;
  let extraData: Record<string, unknown>;
  try {
    extraData = extraFieldsToPrismaData(data);
    insuranceValueCents = dollarsToCents(data.insuranceValue ?? undefined);
    codFeeCents = dollarsToCents(data.codFee ?? undefined);
    totalChargesCents = dollarsToCents(data.totalCharges ?? undefined);
    transitStartAt = toDateOrNull(data.transitStartAt);
    transitEndAt = toDateOrNull(data.transitEndAt);
    shipAt = toDateOrNull(data.shipAt);
    cutoffAt = toDateOrNull(data.cutoffAt);
    etaAt = toDateOrNull(data.etaAt);
    atdAt = toDateOrNull(data.atdAt);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid value" }, { status: 400 });
  }

  const divisionId = data.divisionId ?? ZOHO_DIVISION_ID;
  const busLine = data.busLine ?? ZOHO_BUS_LINE;
  // Same series as Zoho-created shipments (101060000, ...), whatever the division/bus line.
  const fileNumber = await generateShipmentFileNumber();

  const shipment = await prisma.domesticWarehouseShipment.create({
    data: {
      fileNumber,
      divisionId,
      busLine,
      username: session.displayName ?? session.email,
      status: "SCHEDULED",
      domesticType: data.domesticType,
      accountId: data.accountId ?? undefined,
      shipperId: data.shipperId ?? undefined,
      consigneeId: data.consigneeId ?? undefined,
      notifyPartyId: data.notifyPartyId ?? undefined,
      soldToId: data.soldToId ?? undefined,
      shipToId: data.shipToId ?? undefined,
      carrierId: data.carrierId ?? undefined,
      placeOfReceipt: data.placeOfReceipt ?? undefined,
      origin: data.origin ?? undefined,
      destination: data.destination ?? undefined,
      country: data.country ?? undefined,
      placeOfDelivery: data.placeOfDelivery ?? undefined,
      incoTerms: data.incoTerms ?? undefined,
      proNumber: data.proNumber ?? undefined,
      bolNumber: data.bolNumber ?? undefined,
      typeOfService: data.typeOfService ?? undefined,
      otherReference: data.otherReference ?? undefined,
      paymentMethod: data.paymentMethod ?? undefined,
      transitStartAt: transitStartAt ?? undefined,
      transitEndAt: transitEndAt ?? undefined,
      shipAt: shipAt ?? undefined,
      cutoffAt: cutoffAt ?? undefined,
      etaAt: etaAt ?? undefined,
      atdAt: atdAt ?? undefined,
      cargoDescription: data.cargoDescription ?? undefined,
      insurance: data.insurance ?? undefined,
      dryRun: data.dryRun ?? undefined,
      insuranceValueCents: insuranceValueCents ?? undefined,
      codFeeCents: codFeeCents ?? undefined,
      totalChargesCents: totalChargesCents ?? undefined,
      serviceLevel: data.serviceLevel ?? undefined,
      zohoLayoutName: data.zohoLayoutName ?? undefined,
      zohoFields: data.zohoFields ? sanitizeZohoFields(data.zohoFields) : undefined,
      ...(extraData as Partial<Prisma.DomesticWarehouseShipmentCreateInput>),
      createdBy: session.userId,
    },
  });

  await autoCreateInvoiceForShipment(shipment);

  await sendOrderConfirmationEmail(shipment, {});

  return NextResponse.json({ data: shipment }, { status: 201 });
}
