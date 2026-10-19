import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { findOrCreateClient } from "@/lib/clientService";
import { autoGeneratePickupBol } from "@/lib/pickupBol";
import { generateChildFileNumber, generateShipmentFileNumber } from "@/lib/numbering";
import {
  buildTruncatedDraft,
  resolveCustomFields,
  resolveTicketHierarchy,
  resolveTicketMeta,
  truncate,
  MAX_TEXT_LEN,
} from "@/lib/zohoMapping";
import { zohoCfToSectionData } from "@/lib/shipmentZohoSections";
import { zohoCfToLayoutFields } from "@/lib/shipmentLayoutFields";
import { getTicketWithRelationship, listChildTicketIds, pushFileNumberToZohoTicket } from "@/lib/zohoDeskApi";
import { autoCreateInvoiceForShipment } from "@/lib/billing";
import { mapZohoStatusToShipmentStatus } from "@/lib/zohoStatusMap";
import { recordTrackingEvent } from "@/lib/tracking";
import { sendOrderConfirmationEmail } from "@/lib/orderConfirmationEmail";
import { notifyZohoTicketOfFileGenerated } from "@/lib/zohoOrderNotification";

/**
 * Division/line-of-business constants used both when auto-creating shipments from
 * Zoho tickets AND as the default for shipments created via the UI (see
 * src/app/api/shipments/route.ts). They're stored on the shipment (and copied onto its
 * invoices) but no longer drive the file number: since 2026-10 new shipments are numbered
 * 101060000, 101060001, ... and child shipments parent-1, parent-2, ... (see
 * generateShipmentFileNumber / generateChildFileNumber in src/lib/numbering.ts). Older
 * `9965...` / `2065...` numbers are untouched.
 */
export const ZOHO_DIVISION_ID = 99;
export const ZOHO_BUS_LINE = 65;

/**
 * Finds the TMS shipment for a Zoho ticket. Shipments created before parent/child support
 * have no zohoTicketId of their own, so this falls back to the ZohoSync row's fileNumber.
 */
export async function findShipmentByZohoTicketId(zohoTicketId: string) {
  const direct = await prisma.domesticWarehouseShipment.findFirst({ where: { zohoTicketId } });
  if (direct) return direct;
  const sync = await prisma.zohoSync.findUnique({ where: { zohoTicketId }, select: { fileNumber: true } });
  if (!sync?.fileNumber || isPendingCreationClaim(sync.fileNumber)) return null;
  return prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber: sync.fileNumber } });
}

/** Sky2C's Zoho Desk org — the only org using the Air Ops parent / department child flow. */
const PARENT_CHILD_DEFAULT_ORG_ID = "60028198741";

/**
 * Parent/child shipments are Sky2C-only: the same code is deployed for Vhaul4u, which
 * keeps one flat shipment per ticket. ZOHO_PARENT_CHILD_ENABLED ("true"/"false") overrides;
 * when it's unset, the flow is on only for Sky2C's Zoho org.
 */
export function isParentChildEnabled(): boolean {
  const flag = process.env.ZOHO_PARENT_CHILD_ENABLED;
  if (flag) return flag === "true";
  return process.env.ZOHO_DESK_ORG_ID === PARENT_CHILD_DEFAULT_ORG_ID;
}

/**
 * Webhook payloads never include the parent link, so it's read back from the ticket API.
 * Best-effort: on an API failure the ticket is treated as top-level ("") rather than
 * failing shipment creation; a later update webhook gets another chance to link it.
 */
export async function fetchParentTicketId(zohoTicketId: string): Promise<string> {
  if (!isParentChildEnabled()) return "";
  try {
    const ticket = await getTicketWithRelationship(zohoTicketId);
    return resolveTicketHierarchy(ticket).parentTicketId;
  } catch (err) {
    console.error(`[zoho] could not read parent link for ticket ${zohoTicketId}:`, err);
    return "";
  }
}

/**
 * Creates a child shipment for every child ticket of `parentTicketId` that has none yet,
 * fetching each child ticket through the API. This is how children get into TMS when
 * their department (Dispatch, Booking, ...) isn't covered by the webhook — the parent's
 * update webhook fires, and its children are pulled from here. Uses the same ZohoSync
 * audit row + creation claim as the webhooks, so a child ticket that also arrives through
 * its own webhook at the same moment still gets exactly one shipment.
 */
export async function syncChildTicketsForParent(parentTicketId: string): Promise<void> {
  if (!isParentChildEnabled()) return;
  let childIds: string[];
  try {
    childIds = await listChildTicketIds(parentTicketId);
  } catch (err) {
    console.error(`[zoho] could not list child tickets of ${parentTicketId}:`, err);
    return;
  }

  for (const childId of childIds) {
    const sync = await prisma.zohoSync.findUnique({ where: { zohoTicketId: childId } });
    if (sync?.fileNumber) {
      // Already in TMS (or being created right now) — just make sure it's linked.
      if (!isPendingCreationClaim(sync.fileNumber)) {
        const parent = await findShipmentByZohoTicketId(parentTicketId);
        if (parent) {
          await prisma.domesticWarehouseShipment.updateMany({
            where: { fileNumber: sync.fileNumber, id: { not: parent.id } },
            data: { parentId: parent.id, parentZohoTicketId: parentTicketId, zohoTicketId: childId },
          });
        }
      }
      continue;
    }

    try {
      const ticket = await getTicketWithRelationship(childId);
      if (!ticket) continue;
      // Make sure creation sees the parent even if the response nests it differently.
      if (!resolveTicketHierarchy(ticket).parentTicketId) ticket.parentTicketId = parentTicketId;
      const meta = resolveTicketMeta(ticket);
      const auditRow = {
        zohoTicketNumber: meta.ticketNumber || undefined,
        ticketSubject: truncate(meta.subject, MAX_TEXT_LEN),
        ticketStatus: truncate(meta.status, MAX_TEXT_LEN),
        rawPayload: JSON.stringify(ticket),
      };
      await prisma.zohoSync.upsert({
        where: { zohoTicketId: childId },
        create: { zohoTicketId: childId, ...auditRow, syncStatus: "PENDING" },
        update: auditRow,
      });
      if (!(await claimShipmentCreationForTicket(childId))) continue;

      try {
        const result = await createShipmentForTicket(ticket, childId);
        await prisma.zohoSync.update({
          where: { zohoTicketId: childId },
          data: {
            fileNumber: result.fileNumber,
            clientName: result.accountName,
            origin: result.origin,
            destination: result.destination,
            carrier: result.carrierName,
            contactEmail: result.contactEmail,
            contactPhone: result.contactPhone,
            syncStatus: "SYNCED",
            errorMessage: null,
          },
        });
      } catch (err) {
        await prisma.zohoSync.update({
          where: { zohoTicketId: childId },
          data: {
            fileNumber: null,
            syncStatus: "FAILED",
            errorMessage: truncate(err instanceof Error ? err.message : String(err), MAX_TEXT_LEN),
          },
        });
        throw err;
      }
    } catch (err) {
      console.error(`[zoho] failed to sync child ticket ${childId} of ${parentTicketId}:`, err);
    }
  }
}

/**
 * After a shipment is created for a ticket, attaches any child shipments whose ticket
 * webhook arrived first (they were stored with parentZohoTicketId but no parentId yet).
 */
async function adoptWaitingChildren(parentShipmentId: string, zohoTicketId: string): Promise<void> {
  await prisma.domesticWarehouseShipment.updateMany({
    where: {
      parentZohoTicketId: zohoTicketId,
      OR: [{ parentId: null }, { parentId: { isSet: false } }],
    },
    data: { parentId: parentShipmentId },
  });
}

export interface CreateShipmentResult {
  fileNumber: string;
  accountName?: string;
  origin?: string;
  destination?: string;
  carrierName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

/** Sentinel written to ZohoSync.fileNumber while a shipment creation is in flight for a
 * ticket, so a concurrent webhook call can tell "already being created" apart from "not
 * created yet" — see claimShipmentCreationForTicket. Never a real file number (numeric),
 * so it's unambiguous even if a caller reads it mid-flight.
 *
 * IMPORTANT: this is a truthy string, so any caller checking "is a shipment linked yet"
 * must use isPendingCreationClaim(syncRow.fileNumber), NOT a plain `!syncRow.fileNumber`
 * check — the latter would treat a claim-in-progress as "no link yet", fall through to
 * looking up a shipment by this literal sentinel string (which obviously finds none),
 * and wrongly conclude "the shipment was deleted, recreate it" — recreating a duplicate
 * exactly as if the claim had never been checked at all.
 */
const CLAIM_SENTINEL = "__CREATING__";

/** True if `fileNumber` is the in-flight claim sentinel rather than a real file number
 * or null/unset — see CLAIM_SENTINEL. */
export function isPendingCreationClaim(fileNumber: string | null | undefined): boolean {
  return fileNumber === CLAIM_SENTINEL;
}

/**
 * Atomically claims the right to create the shipment for a Zoho ticket, so a
 * ticket-created webhook racing a near-simultaneous ticket-updated webhook for
 * the same brand-new ticket (both can see "no fileNumber yet" if they read at
 * the same moment) can't both create a shipment. MongoDB's single-document
 * updateMany is atomic: only the first caller's update actually matches (the
 * WHERE clause requires fileNumber still unset), so at most one caller ever
 * gets `true` back for a given ticket.
 *
 * Must be called AFTER the ZohoSync row is guaranteed to exist (both webhook
 * handlers upsert it first for audit purposes) but BEFORE calling
 * createShipmentForTicket. Returns false if another call already claimed it
 * (or a real shipment already exists) — the caller should skip creating.
 */
export async function claimShipmentCreationForTicket(zohoTicketId: string): Promise<boolean> {
  const result = await prisma.zohoSync.updateMany({
    where: {
      zohoTicketId,
      OR: [{ fileNumber: null }, { fileNumber: { isSet: false } }],
    },
    data: { fileNumber: CLAIM_SENTINEL },
  });
  return result.count > 0;
}

/**
 * Same idea as claimShipmentCreationForTicket, but for the "ZohoSync points at a
 * fileNumber whose shipment was deleted" recovery path — that case starts from a
 * real (stale) fileNumber, not null/unset, so the claim there is an optimistic
 * concurrency check instead: only succeeds if the row's fileNumber is STILL
 * exactly `staleFileNumber` at the moment of the update. Two concurrent requests
 * both seeing the same stale value can't both win.
 */
export async function claimRecreationForTicket(
  zohoTicketId: string,
  staleFileNumber: string
): Promise<boolean> {
  const result = await prisma.zohoSync.updateMany({
    where: { zohoTicketId, fileNumber: staleFileNumber },
    data: { fileNumber: CLAIM_SENTINEL },
  });
  return result.count > 0;
}

/**
 * Maps a Zoho ticket payload to a DomesticWarehouseShipment, resolving/creating the
 * Account, Shipper, Consignee, and Carrier clients along the way, then inserts the
 * shipment row. Shared by the ticket-created webhook (always) and the ticket-updated
 * webhook (when it discovers no shipment exists yet for a ticket it's seeing an update
 * for — treated like a first-time create per the integration spec).
 *
 * Per the shipper/consignee fallback rule (and the clientService.ts "don't double-print
 * the address" bug fix), Shipper/Consignee are resolved by name only — never with an
 * `address` param — since this ticket layout has no separate address field for either
 * role; when their name resolves to the Origin/Destination text via fallback, that text
 * must not ALSO be stored as street address.
 *
 * After the shipment is created, the generated fileNumber is pushed back onto the
 * originating ticket's "Reference Number" field in Zoho Desk — best-effort: a failure
 * there is logged and swallowed, never allowed to fail shipment creation (the shipment
 * row and ZohoSync audit trail are the source of truth; the push-back is a courtesy).
 */
export async function createShipmentForTicket(
  payload: unknown,
  zohoTicketId: string
): Promise<CreateShipmentResult> {
  const draft = buildTruncatedDraft(payload);

  // A child ticket (Dispatch, Booking, ... raised from an Air Ops ticket) becomes a child
  // shipment. If the parent's shipment doesn't exist yet, parentZohoTicketId is still
  // stored and adoptWaitingChildren links it once the parent is created.
  const hierarchy = resolveTicketHierarchy(payload);
  if (!isParentChildEnabled()) hierarchy.parentTicketId = "";
  else if (!hierarchy.parentTicketId) hierarchy.parentTicketId = await fetchParentTicketId(zohoTicketId);
  const isChild = !!hierarchy.parentTicketId;
  const parent = isChild ? await findShipmentByZohoTicketId(hierarchy.parentTicketId) : null;

  // A child ticket's contact is the internal department mailbox (e.g. "Air Dispatch"),
  // not the customer, so a child takes the parent's account instead.
  const [account, shipper, consignee, carrier] = await Promise.all([
    isChild
      ? Promise.resolve(parent?.accountId ? { id: parent.accountId } : null)
      : draft.accountName
      ? findOrCreateClient({
          name: draft.accountName,
          role: "ACCOUNT",
          emailAddress: draft.contactEmail,
          telephone: draft.contactPhone,
        })
      : Promise.resolve(null),
    draft.shipperName ? findOrCreateClient({ name: draft.shipperName, role: "SHIPPER" }) : Promise.resolve(null),
    draft.consigneeName ? findOrCreateClient({ name: draft.consigneeName, role: "CONSIGNEE" }) : Promise.resolve(null),
    draft.carrierName ? findOrCreateClient({ name: draft.carrierName, role: "CARRIER" }) : Promise.resolve(null),
  ]);

  const meta = resolveTicketMeta(payload);
  const ticketSubject = meta.subject || undefined;
  const status = mapZohoStatusToShipmentStatus(meta.status) ?? "OPEN";

  // A child is numbered after its parent (101060000-1, -2, ...). A child whose parent's
  // shipment doesn't exist yet gets a regular number; it's still linked once the parent
  // arrives (adoptWaitingChildren), but keeps that number.
  const fileNumber = parent ? await generateChildFileNumber(parent.fileNumber) : await generateShipmentFileNumber();

  const shipment = await prisma.domesticWarehouseShipment.create({
    data: {
      fileNumber,
      divisionId: ZOHO_DIVISION_ID,
      busLine: ZOHO_BUS_LINE,
      status,
      domesticType: draft.domesticType,
      parentId: parent?.id,
      zohoTicketId,
      parentZohoTicketId: hierarchy.parentTicketId || undefined,
      zohoDepartmentId: hierarchy.departmentId || undefined,
      zohoLayoutName: hierarchy.layoutName || undefined,
      accountId: account?.id,
      shipperId: shipper?.id,
      consigneeId: consignee?.id,
      carrierId: carrier?.id,
      origin: draft.origin,
      destination: draft.destination,
      proNumber: draft.proNumber,
      bolNumber: draft.bolNumber,
      cargoDescription: draft.cargoDescription,
      dryRun: draft.dryRun,
      totalChargesCents: draft.totalChargesCents ?? undefined,
      shipAt: draft.shipAt ?? undefined,
      ...zohoCfToSectionData(resolveCustomFields(payload)),
      zohoFields: zohoCfToLayoutFields(resolveCustomFields(payload)),
    },
  });

  // Seed the timeline with the shipment's opening status so the tracking page has a
  // first milestone rather than appearing empty until someone changes the status.
  await recordTrackingEvent({
    shipmentId: shipment.id,
    fileNumber,
    status,
    source: "ZOHO",
    note: ticketSubject,
    location: draft.origin ?? null,
  });

  await adoptWaitingChildren(shipment.id, zohoTicketId);

  // Pickup BOL for Dispatch shipments when the auto-generate setting is on. Runs after the
  // webhook has responded — rendering a PDF must not hold up Zoho's request.
  after(() => autoGeneratePickupBol(shipment.id));

  // Billing and customer-facing notices belong to the parent shipment only — a child is
  // an internal department ticket, and invoicing it too would bill the customer twice.
  if (!isChild) {
    await autoCreateInvoiceForShipment(shipment, ticketSubject);
    await sendOrderConfirmationEmail(shipment, { contactEmail: draft.contactEmail });
    await notifyZohoTicketOfFileGenerated(zohoTicketId, shipment.accountId, fileNumber);
  }

  try {
    await pushFileNumberToZohoTicket(zohoTicketId, fileNumber);
  } catch (err) {
    console.error(`[zoho] failed to push fileNumber back to ticket ${zohoTicketId}:`, err);
  }

  return {
    fileNumber,
    accountName: draft.accountName,
    origin: draft.origin,
    destination: draft.destination,
    carrierName: draft.carrierName,
    contactEmail: draft.contactEmail,
    contactPhone: draft.contactPhone,
  };
}
