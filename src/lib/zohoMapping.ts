import type { DomesticType } from "@prisma/client";
import { dollarsToCents } from "@/lib/money";

/**
 * Pure (no-DB) field-mapping helpers for the Zoho Desk ticket webhooks
 * (src/app/api/webhooks/zoho/*). Zoho Desk's webhook payload shape varies by org
 * configuration (custom field API names, and whether custom fields/contact/account
 * nesting sits directly on the payload or under a `ticket` sub-object), so every
 * lookup here is written defensively: try several plausible key paths and take the
 * first non-empty value rather than assuming one fixed shape.
 */

// Most text fields get a generous cap; proNumber (a short carrier-issued code) gets a
// tighter one. Zoho custom field values are operator-entered free text and can be
// arbitrarily long (e.g. someone pastes a full address or a stray URL into a field),
// so every string derived from the payload is truncated before it's ever persisted.
export const MAX_TEXT_LEN = 500;
export const MAX_PRO_NUMBER_LEN = 100;
export const MAX_BOL_NUMBER_LEN = 100;
// Multiline (one quote figure per line), so needs more room than a single-line text field.
export const MAX_DRY_RUN_LEN = 4000;

/** Truncates a possibly-oversized/empty string to a safe max length for persistence. Returns undefined for empty/absent input so optional Prisma fields don't get stored as "". */
export function truncate(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Tries each key against `obj` in order and returns the first non-empty (trimmed) string value found, or "" if none match. */
export function firstNonEmpty(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const val = obj[key];
    if (val === null || val === undefined) continue;
    const str = typeof val === "string" ? val : String(val);
    if (str.trim().length > 0) return str.trim();
  }
  return "";
}

// Org-specific quote-amount custom-field key variants. Kept as an exported array so
// adding another variant later (e.g. "cf_quote_amount_3") is a one-line change.
export const QUOTE_AMOUNT_KEYS = ["cf_quote_amount_1", "cf_quote_amount", "cf_quote_amount_2"];

/** dollarsToCents throws on unparsable input; custom-field text is operator-entered and may not be a valid number, so this wraps it defensively. */
export function safeDollarsToCents(raw: string): number | null {
  if (!raw) return null;
  try {
    return dollarsToCents(raw);
  } catch {
    return null;
  }
}

/** Parses a ship-date custom field that may arrive as an ISO string or an epoch-milliseconds string (both observed from Zoho Desk custom fields depending on field type). Returns null if unparsable. */
export function safeParseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const asEpochMs = new Date(Number(trimmed));
    if (!Number.isNaN(asEpochMs.getTime())) return asEpochMs;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DOMESTIC_TYPE_MAP: Record<string, DomesticType> = {
  truck: "TRUCK",
  truckteam: "TRUCK_TEAM",
  rail: "RAIL",
  motorrail: "MOTOR_RAIL",
  domesticair: "DOMESTIC_AIR",
  pickup: "PICKUP",
  return: "RETURN",
};

/** Maps a free-text domestic-type/service-type custom field value to the DomesticType enum, case-insensitively, falling back to OTHER for unrecognized values. */
export function mapDomesticType(raw: string): DomesticType {
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return DOMESTIC_TYPE_MAP[key] ?? "OTHER";
}

/**
 * Locates the ticket's custom-fields object. Zoho Desk webhook payloads nest custom
 * fields under a `cf` object keyed exactly like the API names in most org configs, but
 * some configs surface a `customFields` key instead, and the holder may be the ticket
 * object itself or (for prevState diffs) the node passed in directly. Tries, in order:
 * node.ticket.cf, node.ticket.customFields, node.cf, node.customFields.
 */
export function resolveCustomFields(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object") return {};
  const n = node as Record<string, unknown>;
  const ticket = (n.ticket ?? undefined) as Record<string, unknown> | undefined;
  const candidates: unknown[] = [ticket?.cf, ticket?.customFields, n.cf, n.customFields];
  for (const c of candidates) {
    if (c && typeof c === "object") return c as Record<string, unknown>;
  }
  return {};
}

export interface TicketMeta {
  ticketId: string;
  ticketNumber: string;
  subject: string;
  status: string;
}

/** Extracts ticket id/number/subject/status, trying both `payload.ticket.*` and bare `payload.*` shapes. */
export function resolveTicketMeta(payload: unknown): TicketMeta {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ticket = (p.ticket ?? undefined) as Record<string, unknown> | undefined;
  return {
    ticketId: firstNonEmpty(ticket, "id", "ticketId") || firstNonEmpty(p, "ticketId", "id"),
    ticketNumber: firstNonEmpty(ticket, "ticketNumber", "number") || firstNonEmpty(p, "ticketNumber"),
    subject: firstNonEmpty(ticket, "subject") || firstNonEmpty(p, "subject"),
    status: firstNonEmpty(ticket, "status") || firstNonEmpty(p, "status"),
  };
}

export interface TicketHierarchy {
  /** Zoho id of the parent ticket when this is a child ticket, else "". */
  parentTicketId: string;
  departmentId: string;
  layoutName: string;
}

/**
 * Extracts the parent-ticket link plus department/layout. None of the payloads captured so
 * far are child tickets, so the exact key Zoho uses for the parent isn't confirmed yet —
 * every plausible shape is tried. Once a real child-ticket payload is in ZohoSync.rawPayload,
 * narrow this to the key it actually uses.
 */
export function resolveTicketHierarchy(payload: unknown): TicketHierarchy {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ticket = (p.ticket ?? undefined) as Record<string, unknown> | undefined;
  const parentKeys = ["parentTicketId", "parentId", "parentTicket_id"];
  const parentObj = (ticket?.parent ?? ticket?.parentTicket ?? p.parent ?? p.parentTicket) as
    | Record<string, unknown>
    | undefined;
  const layout = (ticket?.layoutDetails ?? p.layoutDetails) as Record<string, unknown> | undefined;
  return {
    parentTicketId:
      firstNonEmpty(ticket, ...parentKeys) ||
      firstNonEmpty(p, ...parentKeys) ||
      (parentObj && typeof parentObj === "object" ? firstNonEmpty(parentObj, "id", "ticketId") : ""),
    departmentId: firstNonEmpty(ticket, "departmentId") || firstNonEmpty(p, "departmentId"),
    layoutName: firstNonEmpty(layout, "layoutName"),
  };
}

export interface ContactInfo {
  email: string;
  phone: string;
  accountName: string;
}

/**
 * Extracts contact email/phone and the nested Account name (or the contact's own name
 * when no Account is linked). Tries `node.contact` and
 * `node.ticket.contact` for the contact object (covers `payload.contact.account.accountName`
 * and `payload.ticket.contact.account.accountName` shapes per the integration spec).
 */
export function resolveContactInfo(node: unknown): ContactInfo {
  if (!node || typeof node !== "object") return { email: "", phone: "", accountName: "" };
  const n = node as Record<string, unknown>;
  const ticket = (n.ticket ?? undefined) as Record<string, unknown> | undefined;
  const contactCandidates: unknown[] = [n.contact, ticket?.contact];
  let contact: Record<string, unknown> | undefined;
  for (const c of contactCandidates) {
    if (c && typeof c === "object") {
      contact = c as Record<string, unknown>;
      break;
    }
  }
  const email = firstNonEmpty(contact, "email");
  const phone = firstNonEmpty(contact, "phone", "mobile");
  const account = (contact?.account ?? undefined) as Record<string, unknown> | undefined;
  // Most Zoho Desk contacts aren't linked to an Account, so fall back to the contact
  // itself (full name, then email) as the shipment's account.
  const contactName = [firstNonEmpty(contact, "firstName"), firstNonEmpty(contact, "lastName")].filter(Boolean).join(" ");
  const accountName = firstNonEmpty(account, "accountName") || contactName || email;
  return { email, phone, accountName };
}

export interface RawShipmentFields {
  shipperName: string;
  consigneeName: string;
  origin: string;
  destination: string;
  carrier: string;
  proNumber: string;
  bolNumber: string;
  shipDateRaw: string;
  cargoDescription: string;
  domesticTypeRaw: string;
  quoteAmountRaw: string;
  /** cf_multiple_quotes — multiline quote history, one figure per line; parsed into invoice line items, see src/lib/billing.ts. */
  dryRunRaw: string;
}

/** Applies the field-mapping table (see integration spec) to a resolved custom-fields object. Raw/untruncated — callers truncate before persisting. */
export function mapCustomFieldsToDraft(cf: Record<string, unknown>): RawShipmentFields {
  return {
    // Shipper / Consignee clients come from the ticket's Pickup Location and Destination
    // Address — never the Origin / Destination port codes.
    shipperName: firstNonEmpty(cf, "cf_pickup_location"),
    consigneeName: firstNonEmpty(cf, "cf_destination_address"),
    origin: firstNonEmpty(cf, "cf_origin", "cf_pickup_location", "cf_pickup_address"),
    destination: firstNonEmpty(cf, "cf_destination", "cf_delivery_location", "cf_delivery_address"),
    carrier: firstNonEmpty(cf, "cf_carrier", "cf_carrier_name", "cf_carrier_name_1"),
    proNumber: firstNonEmpty(cf, "cf_pro_number"),
    // TODO: confirm the real Zoho Desk API name for the "BOL Number" field against a live
    // ticket payload — org custom-field API names don't always match their UI labels
    // (see cf_pickup_country actually holding "Reference Number" in pushFileNumberToZohoTicket).
    bolNumber: firstNonEmpty(cf, "cf_bol_number", "cf_bol"),
    // Shown as "Pickup Date" in the Dispatch Operations section (src/lib/shipmentZohoSections.ts).
    shipDateRaw: firstNonEmpty(cf, "cf_pickup_date", "cf_etd", "cf_ship_date", "cf_pickup_date_1"),
    // Shown as "Commodity Detail" in the Dispatch Instructions section.
    cargoDescription: firstNonEmpty(cf, "cf_commodity_detail", "cf_cargo_description"),
    domesticTypeRaw: firstNonEmpty(cf, "cf_domestic_type", "cf_service_type") || "Truck",
    quoteAmountRaw: firstNonEmpty(cf, ...QUOTE_AMOUNT_KEYS),
    dryRunRaw: firstNonEmpty(cf, "cf_multiple_quotes"),
  };
}

export interface ComparableShipmentFields {
  origin: string;
  destination: string;
  carrier: string;
  shipDateRaw: string;
  /** cf_pickup_location (Pickup Location). */
  shipperName: string;
  /** cf_destination_address (Destination Address). */
  consigneeName: string;
  accountName: string;
}

/**
 * Builds the 7 comparable fields (Origin/Destination/Carrier/ShipDate/ShipperName/
 * ConsigneeName/AccountName) used by the ticket-updated webhook's change detection.
 * Works against either the current payload or `prevState` — both are resolved through
 * the same defensive custom-field/contact lookup so the comparison is apples-to-apples.
 */
export function buildComparableFields(node: unknown): ComparableShipmentFields {
  const cf = resolveCustomFields(node);
  const raw = mapCustomFieldsToDraft(cf);
  const contact = resolveContactInfo(node);
  return {
    origin: raw.origin,
    destination: raw.destination,
    carrier: raw.carrier,
    shipDateRaw: raw.shipDateRaw,
    shipperName: raw.shipperName,
    consigneeName: raw.consigneeName,
    accountName: contact.accountName,
  };
}

export interface TruncatedShipmentDraft {
  origin?: string;
  destination?: string;
  carrierName?: string;
  proNumber?: string;
  bolNumber?: string;
  cargoDescription?: string;
  /** cf_multiple_quotes, verbatim (line breaks preserved) — see RawShipmentFields.dryRunRaw. */
  dryRun?: string;
  domesticType: DomesticType;
  totalChargesCents: number | null;
  shipAt: Date | null;
  /** Shipper client name — the ticket's Pickup Location; absent when that's empty (no port fallback). */
  shipperName?: string;
  /** Consignee client name — the ticket's Destination Address; absent when that's empty. */
  consigneeName?: string;
  accountName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

/** Builds the full, truncated, persistence-ready field draft for a ticket payload (or prevState node). Pure mapping only — no DB/client resolution. */
export function buildTruncatedDraft(node: unknown): TruncatedShipmentDraft {
  const cf = resolveCustomFields(node);
  const raw = mapCustomFieldsToDraft(cf);
  const contact = resolveContactInfo(node);

  return {
    origin: truncate(raw.origin, MAX_TEXT_LEN),
    destination: truncate(raw.destination, MAX_TEXT_LEN),
    carrierName: truncate(raw.carrier, MAX_TEXT_LEN),
    proNumber: truncate(raw.proNumber, MAX_PRO_NUMBER_LEN),
    bolNumber: truncate(raw.bolNumber, MAX_BOL_NUMBER_LEN),
    cargoDescription: truncate(raw.cargoDescription, MAX_TEXT_LEN),
    dryRun: truncate(raw.dryRunRaw, MAX_DRY_RUN_LEN),
    domesticType: mapDomesticType(raw.domesticTypeRaw),
    totalChargesCents: raw.quoteAmountRaw ? safeDollarsToCents(raw.quoteAmountRaw) : null,
    shipAt: raw.shipDateRaw ? safeParseDate(raw.shipDateRaw) : null,
    shipperName: truncate(raw.shipperName, MAX_TEXT_LEN),
    consigneeName: truncate(raw.consigneeName, MAX_TEXT_LEN),
    accountName: truncate(contact.accountName, MAX_TEXT_LEN),
    contactEmail: truncate(contact.email, MAX_TEXT_LEN),
    contactPhone: truncate(contact.phone, MAX_TEXT_LEN),
  };
}

/**
 * Zoho sends webhook bodies as a JSON array with one event envelope (`[{ payload, eventType, ... }]`),
 * but defensively handle a bare object too in case an org config posts one directly.
 */
export function extractEventEnvelope(body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) return (body[0] ?? {}) as Record<string, unknown>;
  if (body && typeof body === "object") return body as Record<string, unknown>;
  return {};
}
