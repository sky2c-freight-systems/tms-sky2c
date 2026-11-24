import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { buildPrintableAddress } from "@/lib/clientService";
import { dollarsToCents } from "@/lib/money";
import { ensureCustomerInQBO } from "@/lib/qbo";

/** GET /api/clients/[id] — single client by id. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  return NextResponse.json(client);
}

const updateClientSchema = z.object({
  name: z.string().min(1).optional(),
  street: z.string().nullish(),
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  zipCode: z.string().nullish(),
  country: z.string().nullish(),
  isNonUS: z.boolean().optional(),
  telephone: z.string().nullish(),
  fax: z.string().nullish(),
  emailAddress: z.string().nullish(),
  accountingEmailAddress: z.string().nullish(),
  contact: z.string().nullish(),
  contactLastName: z.string().nullish(),
  exporterIdNumber: z.string().trim().max(20).nullish(),
  exporterIdType: z.enum(["E", "D", "T"]).or(z.literal("")).nullish(),
  scacCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "SCAC is 2-4 letters").or(z.literal("")).nullish(),
  clientType: z.string().nullish(),
  isActive: z.boolean().optional(),
  isShipper: z.boolean().optional(),
  isConsignee: z.boolean().optional(),
  isCarrier: z.boolean().optional(),
  isNotify: z.boolean().optional(),
  isSoldTo: z.boolean().optional(),
  isShipTo: z.boolean().optional(),
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
  creditTermsDays: z.number().int().nullish(),
  creditLimit: z.union([z.string(), z.number()]).nullish(),
  arDefaultTermsDays: z.number().int().nullish(),
  arCreditLimit: z.union([z.string(), z.number()]).nullish(),
});

/**
 * PATCH /api/clients/[id] — partial update. Recomputes `printableAddress` whenever
 * name or any address field is included in the patch.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await prisma.client.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = updateClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  let creditLimitCents: number | null | undefined;
  let arCreditLimitCents: number | null | undefined;
  try {
    if ("creditLimit" in data) creditLimitCents = dollarsToCents(data.creditLimit ?? undefined);
    if ("arCreditLimit" in data) arCreditLimitCents = dollarsToCents(data.arCreditLimit ?? undefined);
  } catch {
    return NextResponse.json({ error: "Invalid credit limit amount" }, { status: 400 });
  }

  const update: Prisma.ClientUpdateInput = {
    name: data.name,
    street: data.street,
    addressLine1: data.addressLine1,
    addressLine2: data.addressLine2,
    city: data.city,
    state: data.state,
    zipCode: data.zipCode,
    country: data.country,
    isNonUS: data.isNonUS,
    telephone: data.telephone,
    fax: data.fax,
    emailAddress: data.emailAddress,
    accountingEmailAddress: data.accountingEmailAddress,
    contact: data.contact,
    contactLastName: data.contactLastName,
    exporterIdNumber: data.exporterIdNumber === "" ? null : data.exporterIdNumber,
    exporterIdType: data.exporterIdType === "" ? null : data.exporterIdType,
    scacCode: data.scacCode === "" ? null : data.scacCode,
    clientType: data.clientType,
    isActive: data.isActive,
    isShipper: data.isShipper,
    isConsignee: data.isConsignee,
    isCarrier: data.isCarrier,
    isNotify: data.isNotify,
    isSoldTo: data.isSoldTo,
    isShipTo: data.isShipTo,
    isCustomer: data.isCustomer,
    isVendor: data.isVendor,
    creditTermsDays: data.creditTermsDays,
    arDefaultTermsDays: data.arDefaultTermsDays,
  };
  if (creditLimitCents !== undefined) update.creditLimitCents = creditLimitCents;
  if (arCreditLimitCents !== undefined) update.arCreditLimitCents = arCreditLimitCents;

  // Strip undefined keys so Prisma doesn't try to write `undefined` over existing values.
  for (const key of Object.keys(update) as (keyof typeof update)[]) {
    if (update[key] === undefined) delete update[key];
  }

  const nameOrAddressChanged =
    data.name !== undefined ||
    ["street", "addressLine1", "addressLine2", "city", "state", "zipCode", "country"].some(
      (k) => k in data
    );
  if (nameOrAddressChanged) {
    const merged = { ...existing, ...data };
    update.printableAddress = buildPrintableAddress(merged.name, merged);
  }

  const client = await prisma.client.update({ where: { id }, data: update });

  // Best-effort: Accounting Email Address is the authoritative billing email QBO
  // invoices go to (see ensureCustomerInQBO's email-diff logic in qbo.ts). For a client
  // that's already a QBO customer, push the change immediately rather than waiting for
  // the next invoice to happen to sync it. A client not yet linked to QBO is left alone
  // here — it gets its QBO customer created lazily on first invoice push, as always.
  // Never blocks the client save: QBO being down/disconnected must not fail this PATCH.
  if (data.accountingEmailAddress !== undefined && client.qboCustomerId) {
    try {
      await ensureCustomerInQBO(client);
    } catch (err) {
      console.error(`[clients] failed to push accounting email to QBO for client ${client.id}:`, err);
    }
  }

  return NextResponse.json(client);
}
