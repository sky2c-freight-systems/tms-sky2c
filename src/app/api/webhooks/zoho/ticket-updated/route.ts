import { NextResponse, after } from "next/server";
import { randomUUID } from "crypto";
import { autoGeneratePickupBol } from "@/lib/pickupBol";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findOrCreateClient } from "@/lib/clientService";
import { isZohoWebhookAuthorized } from "@/lib/zohoAuth";
import {
  buildComparableFields,
  buildTruncatedDraft,
  extractEventEnvelope,
  resolveCustomFields,
  resolveTicketHierarchy,
  resolveTicketMeta,
  truncate,
  MAX_TEXT_LEN,
} from "@/lib/zohoMapping";
import {
  createShipmentForTicket,
  claimShipmentCreationForTicket,
  claimRecreationForTicket,
  fetchParentTicketId,
  findShipmentByZohoTicketId,
  isParentChildEnabled,
  isPendingCreationClaim,
  syncChildTicketsForParent,
} from "@/lib/zohoShipmentSync";
import { autoCreateInvoiceForShipment, syncInvoiceAmountToShipment } from "@/lib/billing";
import { mapZohoStatusToShipmentStatus } from "@/lib/zohoStatusMap";
import { recordStatusChange } from "@/lib/tracking";
import { zohoCfToSectionData } from "@/lib/shipmentZohoSections";
import { asZohoFields, zohoCfToLayoutFields } from "@/lib/shipmentLayoutFields";

/**
 * Zoho Desk "Ticket_Update" webhook. Same body shape as ticket-created plus a
 * `prevState` sibling of `payload` reflecting the ticket's fields before this update.
 * MUST always return HTTP 200 — see ticket-created's route for the same rationale.
 *
 * This is the explicit legacy-bug fix: whenever Origin, Destination, or the resolved
 * AccountName changes, Shipper/Consignee/Account are re-resolved via findOrCreateClient
 * (not just the origin/destination text fields updated) — the legacy bug left
 * Shipper/Consignee pointed at the stale client from creation time.
 */
export async function POST(request: Request) {
  if (!isZohoWebhookAuthorized(request)) {
    console.warn("[zoho:ticket-updated] rejected: invalid or missing shared-secret header");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const rawBody = await request.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    console.error("[zoho:ticket-updated] failed to parse JSON body; storing raw body for audit only");
  }

  const envelope = extractEventEnvelope(parsedBody);
  const payload = (envelope.payload ?? envelope) as Record<string, unknown>;
  // prevState is expected to sit alongside payload in the same event envelope; if Zoho's
  // org config nests it differently or omits it (e.g. field-level webhooks), default to
  // {} so comparison just treats every current field as "changed" — the safe direction,
  // since it triggers the re-resolve fix rather than silently skipping it.
  const prevState = (envelope.prevState ?? {}) as Record<string, unknown>;

  // Zoho's empty-body URL validation request on webhook save — no ticket, nothing to sync.
  if (Object.keys(payload).length === 0) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const meta = resolveTicketMeta(payload);
  const zohoTicketId = meta.ticketId || `unknown-${randomUUID()}`;

  let syncRow = await prisma.zohoSync.findUnique({ where: { zohoTicketId } });
  if (!syncRow) {
    syncRow = await prisma.zohoSync.create({
      data: {
        zohoTicketId,
        zohoTicketNumber: meta.ticketNumber || undefined,
        ticketSubject: truncate(meta.subject, MAX_TEXT_LEN),
        ticketStatus: truncate(meta.status, MAX_TEXT_LEN),
        rawPayload: rawBody,
        syncStatus: "PENDING",
      },
    });
  } else {
    syncRow = await prisma.zohoSync.update({
      where: { zohoTicketId },
      data: {
        ticketStatus: truncate(meta.status, MAX_TEXT_LEN),
        rawPayload: rawBody,
      },
    });
  }

  // Tracks whether THIS request is the one that flipped fileNumber to the claim
  // sentinel, so the catch block below knows whether to release it on failure -
  // inferring that from syncRow.fileNumber's original value is ambiguous now that
  // there are two claim call sites (fresh-create vs. recreate-after-deletion).
  let weClaimedSentinel = false;

  try {
    // A concurrent request (ticket-created, or another ticket-updated delivery -
    // Zoho can send more than one for a single edit) already claimed the right to
    // create this ticket's shipment and hasn't finished yet. Nothing to do but
    // wait for it - there's no shipment to update yet, and re-attempting the
    // claim or looking up a shipment by this sentinel would both be wrong (the
    // literal bug this whole function exists to prevent).
    if (isPendingCreationClaim(syncRow.fileNumber)) {
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // No ZohoSync row with a shipment yet for this ticket — treat this update like a
    // first-time create rather than failing (per the integration spec). Claim the
    // right to create atomically first: a near-simultaneous ticket-created webhook
    // for the same brand-new ticket can otherwise race this handler into both
    // creating a shipment for the same ticket (see claimShipmentCreationForTicket).
    if (!syncRow.fileNumber) {
      const claimed = await claimShipmentCreationForTicket(zohoTicketId);
      if (!claimed) {
        // Someone else (the ticket-created webhook, most likely) is already
        // creating the shipment from its own payload — nothing to update yet.
        return NextResponse.json({ received: true }, { status: 200 });
      }
      weClaimedSentinel = true;

      const result = await createShipmentForTicket(payload, zohoTicketId);
      await prisma.zohoSync.update({
        where: { zohoTicketId },
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
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const currentFields = buildComparableFields(payload);
    const prevFields = buildComparableFields(prevState);

    const shipment = await prisma.domesticWarehouseShipment.findUnique({
      where: { fileNumber: syncRow.fileNumber },
    });

    // ZohoSync points at a real fileNumber but the shipment itself is gone (e.g.
    // manually deleted) — also treat as a fresh create rather than throwing. Claim
    // first for the same reason as above (optimistic-concurrency variant, since
    // this starts from a real stale fileNumber rather than null/unset).
    if (!shipment) {
      const claimed = await claimRecreationForTicket(zohoTicketId, syncRow.fileNumber);
      if (!claimed) {
        return NextResponse.json({ received: true }, { status: 200 });
      }
      weClaimedSentinel = true;

      const result = await createShipmentForTicket(payload, zohoTicketId);
      await prisma.zohoSync.update({
        where: { zohoTicketId },
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
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const draft = buildTruncatedDraft(payload);

    const accountNameChanged = currentFields.accountName !== prevFields.accountName;

    const updateData: Prisma.DomesticWarehouseShipmentUpdateInput = {
      origin: draft.origin,
      destination: draft.destination,
      proNumber: draft.proNumber,
      bolNumber: draft.bolNumber,
      cargoDescription: draft.cargoDescription,
      dryRun: draft.dryRun,
      domesticType: draft.domesticType,
      totalChargesCents: draft.totalChargesCents ?? undefined,
      shipAt: draft.shipAt ?? undefined,
      // Dispatch / Pickup section fields (src/lib/shipmentZohoSections.ts).
      ...zohoCfToSectionData(resolveCustomFields(payload)),
      // Remaining layout fields (src/lib/shipmentLayoutFields.ts), merged so a field the
      // payload doesn't carry keeps its stored value.
      zohoFields: { ...asZohoFields(shipment.zohoFields), ...zohoCfToLayoutFields(resolveCustomFields(payload)) },
    };

    // Zoho ticket status -> shipment status, one leg of the two-way sync (the other
    // leg is the manual PATCH route pushing shipment status changes back to Zoho via
    // updateTicket — see src/lib/zohoStatusMap.ts). Only applied when the ticket's
    // status maps to a known ShipmentStatus, so an unrecognized/renamed Zoho status
    // never silently wipes out whatever status TMS already has.
    const mappedStatus = mapZohoStatusToShipmentStatus(meta.status);
    if (mappedStatus) updateData.status = mappedStatus;

    // Backfills the ticket link on shipments created before parent/child support, and
    // picks up a parent link that appears only after creation (ticket made a child later).
    const hierarchy = resolveTicketHierarchy(payload);
    if (!isParentChildEnabled()) hierarchy.parentTicketId = "";
    else if (!hierarchy.parentTicketId && !shipment.parentZohoTicketId) {
      hierarchy.parentTicketId = await fetchParentTicketId(zohoTicketId);
    }
    updateData.zohoTicketId = zohoTicketId;
    if (hierarchy.departmentId) updateData.zohoDepartmentId = hierarchy.departmentId;
    if (hierarchy.layoutName) updateData.zohoLayoutName = hierarchy.layoutName;
    if (hierarchy.parentTicketId && hierarchy.parentTicketId !== shipment.parentZohoTicketId) {
      updateData.parentZohoTicketId = hierarchy.parentTicketId;
      const parent = await findShipmentByZohoTicketId(hierarchy.parentTicketId);
      if (parent && parent.id !== shipment.id) updateData.parentId = parent.id;
    }
    const isChild = !!(hierarchy.parentTicketId || shipment.parentZohoTicketId);

    if (draft.carrierName) {
      const carrier = await findOrCreateClient({ name: draft.carrierName, role: "CARRIER" });
      updateData.carrierId = carrier.id;
    }

    // Shipper (Pickup Location) and Consignee (Destination Address) are re-resolved on every
    // update, so a shipment whose parties were set the old way (from the port codes) is
    // corrected by its next ticket update. The account only when its name changed.
    const [account, shipper, consignee] = await Promise.all([
      accountNameChanged && draft.accountName
        ? findOrCreateClient({
            name: draft.accountName,
            role: "ACCOUNT",
            emailAddress: draft.contactEmail,
            telephone: draft.contactPhone,
          })
        : Promise.resolve(null),
      draft.shipperName ? findOrCreateClient({ name: draft.shipperName, role: "SHIPPER" }) : Promise.resolve(null),
      draft.consigneeName ? findOrCreateClient({ name: draft.consigneeName, role: "CONSIGNEE" }) : Promise.resolve(null),
    ]);
    // A child keeps the parent's account — its own contact is a department mailbox.
    if (account && !isChild) updateData.accountId = account.id;
    // Zoho is the source of truth: an empty Pickup Location / Destination Address clears the
    // party rather than keeping one set the old way from a port code.
    updateData.shipperId = shipper?.id ?? null;
    updateData.consigneeId = consignee?.id ?? null;

    const updatedShipment = await prisma.domesticWarehouseShipment.update({
      where: { fileNumber: syncRow.fileNumber },
      data: updateData,
    });
    // Refresh the Pickup BOL when the auto-generate setting is on (after the response).
    after(() => autoGeneratePickupBol(updatedShipment.id));

    // `shipment` was read before this update, so its status is the pre-update value —
    // exactly what recordStatusChange needs to tell a real transition from a no-op
    // re-sync of the same status.
    if (updateData.status !== undefined) {
      await recordStatusChange(
        updatedShipment.id,
        updatedShipment.fileNumber,
        shipment.status,
        updatedShipment.status,
        "ZOHO",
        updatedShipment.destination ?? updatedShipment.origin ?? null
      );
    }

    // Handles the case where the ticket had no quote amount (or no resolved
    // Account) yet when the shipment was first created, so autoCreateInvoiceForShipment
    // skipped it back then - if this update is what finally supplies the missing
    // piece, create the invoice now. Safe to call unconditionally: it's a no-op if
    // an invoice already exists, or if the shipment still isn't eligible.
    // Child shipments are never invoiced — billing lives on the parent (see
    // createShipmentForTicket).
    if (!isChild) {
      await autoCreateInvoiceForShipment(updatedShipment, meta.subject);
      // Handles the opposite case - an invoice already exists and this update changed
      // the charge amount and/or the Dry Run quote history. Also a no-op if there's no
      // invoice yet (the call above either just created one, in which case its line
      // items already match, or the shipment still isn't eligible for one).
      await syncInvoiceAmountToShipment(shipment.id, {
        totalChargesCents: draft.totalChargesCents,
        dryRun: draft.dryRun ?? null,
      });
    }

    await prisma.zohoSync.update({
      where: { zohoTicketId },
      data: {
        origin: draft.origin,
        destination: draft.destination,
        carrier: draft.carrierName,
        clientName: draft.accountName,
        contactEmail: draft.contactEmail,
        contactPhone: draft.contactPhone,
        syncStatus: "SYNCED",
        errorMessage: null,
      },
    });

    // Adding a child ticket in Zoho fires an update on the parent; pull in any children
    // that don't have a shipment yet. Never throws — failures are logged per child.
    if (!isChild) await syncChildTicketsForParent(zohoTicketId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zoho:ticket-updated] sync failed for ticket ${zohoTicketId}:`, err);
    await prisma.zohoSync
      .update({
        where: { zohoTicketId },
        data: {
          // Only release the claim sentinel if THIS request was the one that set
          // it (via either claim call above) - if this request never claimed
          // anything (e.g. the update-existing-shipment path failed for some
          // unrelated reason), leave whatever fileNumber is there alone.
          ...(weClaimedSentinel ? { fileNumber: null } : {}),
          syncStatus: "FAILED",
          errorMessage: truncate(message, MAX_TEXT_LEN),
        },
      })
      .catch((updateErr) => {
        console.error(`[zoho:ticket-updated] failed to record FAILED status for ticket ${zohoTicketId}:`, updateErr);
      });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
