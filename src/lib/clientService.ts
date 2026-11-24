import type { Client, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateClientId } from "@/lib/numbering";
import { escapeRegex } from "@/lib/mongoText";

/**
 * Shared Client (party/company master) service. Every Shipper/Consignee/Carrier/
 * Account/Notify/SoldTo/ShipTo across the app is a row in the single `Client`
 * collection, matched by the human-readable `clientId` business key. This module is
 * the ONE place clients get created or resolved-by-name — used by the "add new
 * client" modal in the shipment form AND by the Zoho webhook handlers, so the
 * find-or-create behavior (and its bug fixes) only exist in one place.
 */

export type ClientRole =
  | "SHIPPER"
  | "CONSIGNEE"
  | "CARRIER"
  | "NOTIFY"
  | "SOLD_TO"
  | "SHIP_TO"
  | "ACCOUNT";

export const ROLE_FLAG_FIELD: Record<ClientRole, keyof Client> = {
  SHIPPER: "isShipper",
  CONSIGNEE: "isConsignee",
  CARRIER: "isCarrier",
  NOTIFY: "isNotify",
  SOLD_TO: "isSoldTo",
  SHIP_TO: "isShipTo",
  ACCOUNT: "isCustomer",
};

export interface ClientAddressInput {
  street?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
}

export function buildPrintableAddress(name: string, address?: ClientAddressInput | null): string {
  if (!address) return name;
  const lines = [
    address.street ?? address.addressLine1,
    address.addressLine2,
    [address.city, address.state, address.zipCode].filter(Boolean).join(", "),
    address.country,
  ].filter((part): part is string => !!part && part.trim().length > 0);
  return [name, ...lines].join("\n");
}

export interface FindOrCreateClientInput {
  name: string;
  role: ClientRole;
  /**
   * Physical address for this client. IMPORTANT: when `name` was itself derived as a
   * fallback from an address string (e.g. the Zoho ticket-created webhook falling back
   * to the Origin/Destination text as the Shipper/Consignee name because the ticket has
   * no separate name field), do NOT also pass that same text as `address` — the legacy
   * app did this and printed the same address twice on the BOL. Omit `address`
   * entirely in that case; only pass it when it's genuinely distinct from `name`.
   */
  address?: ClientAddressInput | null;
  telephone?: string | null;
  emailAddress?: string | null;
  contact?: string | null;
}

/**
 * Finds an existing active Client by case-insensitive exact name match, or creates one.
 * Whichever branch runs, the role flag for `role` is guaranteed to be set on the
 * returned record (fixing the legacy gap where `UseAsCustomer`/isCustomer was never
 * actually set when a client was resolved for the Account role via the Zoho flow).
 */
export async function findOrCreateClient(input: FindOrCreateClientInput): Promise<Client> {
  const name = input.name.trim();
  if (!name) throw new Error("findOrCreateClient: name is required");

  const roleField = ROLE_FLAG_FIELD[input.role];

  const existing = await prisma.client.findFirst({
    where: { name: { equals: escapeRegex(name), mode: "insensitive" }, isActive: true },
  });

  if (existing) {
    const patch: Prisma.ClientUpdateInput = {};
    if (!existing[roleField]) (patch as Record<string, unknown>)[roleField] = true;
    if (input.role === "ACCOUNT" && !existing.isCustomer) patch.isCustomer = true;
    // Backfill contact info that's missing on the existing record — a client is
    // commonly first resolved (e.g. by a Zoho ticket with no contact fields) before
    // a later sync has an email/phone/contact name for the same name match. Never
    // overwrites a value that's already set, only fills genuine gaps.
    if (!existing.emailAddress && input.emailAddress) patch.emailAddress = input.emailAddress;
    if (!existing.telephone && input.telephone) patch.telephone = input.telephone;
    if (!existing.contact && input.contact) patch.contact = input.contact;
    if (Object.keys(patch).length === 0) return existing;
    return prisma.client.update({ where: { id: existing.id }, data: patch });
  }

  return createClient({
    name,
    ...input.address,
    telephone: input.telephone ?? undefined,
    emailAddress: input.emailAddress ?? undefined,
    contact: input.contact ?? undefined,
    roles: [input.role],
  });
}

export interface CreateClientInput extends ClientAddressInput {
  name: string;
  isNonUS?: boolean;
  telephone?: string;
  fax?: string;
  emailAddress?: string;
  accountingEmailAddress?: string;
  contact?: string;
  contactLastName?: string;
  exporterIdNumber?: string;
  exporterIdType?: string;
  scacCode?: string;
  clientType?: string;
  roles?: ClientRole[];
  creditTermsDays?: number;
  creditLimitCents?: number;
  arDefaultTermsDays?: number;
  arCreditLimitCents?: number;
}

/** Creates a brand-new Client with a freshly generated `clientId`. Used by the manual "add new client" modal and by findOrCreateClient. */
export async function createClient(input: CreateClientInput): Promise<Client> {
  const name = input.name.trim();
  const clientId = await generateClientId(name);
  const roleFlags: Partial<Record<string, boolean>> = {};
  for (const role of input.roles ?? []) {
    roleFlags[ROLE_FLAG_FIELD[role]] = true;
  }

  return prisma.client.create({
    data: {
      clientId,
      name,
      street: input.street,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      country: input.country,
      isNonUS: input.isNonUS ?? false,
      telephone: input.telephone,
      fax: input.fax,
      emailAddress: input.emailAddress,
      accountingEmailAddress: input.accountingEmailAddress,
      contact: input.contact,
      contactLastName: input.contactLastName,
      exporterIdNumber: input.exporterIdNumber,
      exporterIdType: input.exporterIdType,
      scacCode: input.scacCode,
      clientType: input.clientType,
      printableAddress: buildPrintableAddress(name, input),
      isActive: true,
      creditTermsDays: input.creditTermsDays,
      creditLimitCents: input.creditLimitCents,
      arDefaultTermsDays: input.arDefaultTermsDays,
      arCreditLimitCents: input.arCreditLimitCents,
      ...roleFlags,
    },
  });
}

export interface ClientSearchOptions {
  query?: string;
  role?: ClientRole;
  activeOnly?: boolean;
  limit?: number;
}

/** Type-ahead / search-modal lookup against clientId and name, optionally filtered by role flag. */
export async function searchClients(opts: ClientSearchOptions = {}): Promise<Client[]> {
  const where: Prisma.ClientWhereInput = {};
  if (opts.activeOnly !== false) where.isActive = true;
  if (opts.role) (where as Record<string, unknown>)[ROLE_FLAG_FIELD[opts.role]] = true;
  if (opts.query) {
    where.OR = [
      { name: { contains: escapeRegex(opts.query), mode: "insensitive" } },
      { clientId: { contains: escapeRegex(opts.query), mode: "insensitive" } },
    ];
  }
  return prisma.client.findMany({
    where,
    orderBy: { name: "asc" },
    take: opts.limit ?? 25,
  });
}
