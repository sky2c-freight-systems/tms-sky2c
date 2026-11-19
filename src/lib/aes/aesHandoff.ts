import type { Client } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { escapeRegex } from "@/lib/mongoText";
import { getAesConfig, type AesConfig } from "@/lib/aes/config";
import { buildWeblinkFields, type AesMappingResult, type AesParty } from "@/lib/aes/weblinkFields";
import { fieldsHash } from "@/lib/aes/audit";
import { getAesDetails, type StoredAesDetails } from "@/lib/aes/aesDetailsStore";
import { asZohoFields } from "@/lib/shipmentLayoutFields";

// Loads the shipment and builds the AES fields. Read-only.

export interface AesHandoff {
  fileNumber: string;
  // Shipment id.
  shipmentId: string;
  // Changes only if the shipment changed.
  fieldsHash: string;
  config: AesConfig;
  mapping: AesMappingResult;
  // Status check fields, or null if no filer ID.
  inquiry: { fields: Record<string, string>; returnsToTms: boolean } | null;
  // Saved AES details, or null.
  details: StoredAesDetails | null;
}

// Return URL for CBP. Values go in the path because CBP adds its own "?..." params.
export function aesReturnUrl(baseUrl: string, outcome: "success" | "failure" | "status", fileNumber: string, nonce?: string): string {
  const base = `${baseUrl}/api/aes/return/${outcome}/${encodeURIComponent(fileNumber)}`;
  return nonce ? `${base}/${encodeURIComponent(nonce)}` : base;
}

function toParty(c: Client | null): AesParty | null {
  if (!c) return null;
  return {
    clientId: c.clientId,
    name: c.name,
    street: c.street,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    state: c.state,
    zipCode: c.zipCode,
    country: c.country,
    telephone: c.telephone,
    contact: c.contact,
    contactLastName: c.contactLastName,
  };
}

async function clientById(id: string | null | undefined): Promise<Client | null> {
  if (!id) return null;
  return prisma.client.findUnique({ where: { id } });
}

// Port code from the Location table, if it looks valid.
async function portCodeFor(names: Array<string | null | undefined>, pattern: RegExp): Promise<string> {
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    if (pattern.test(name)) return name; // already a code
    const location = await prisma.location.findFirst({
      where: { name: { equals: escapeRegex(name), mode: "insensitive" }, isActive: true },
      select: { code: true },
    });
    const code = (location?.code ?? "").trim();
    if (pattern.test(code)) return code;
  }
  return "";
}

// APP_BASE_URL, else the request host.
export function resolveAppBaseUrl(requestHeaders: Headers): string {
  const configured = (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const proto = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function buildAesHandoff(
  fileNumber: string,
  opts: { userEmail: string | null | undefined; baseUrl: string; now?: Date; nonce?: string }
): Promise<AesHandoff | null> {
  const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber } });
  if (!shipment) return null;

  const config = getAesConfig();
  const details = await getAesDetails(shipment.id);
  const awbRaw = asZohoFields(shipment.zohoFields).cf_awb;
  const zohoAwb = typeof awbRaw === "string" ? awbRaw : null;

  const [shipper, account, consignee, shipTo, carrier, forwarder, containers, portOfExportCode, portOfUnladingCode] =
    await Promise.all([
      clientById(shipment.shipperId),
      clientById(shipment.accountId),
      clientById(shipment.consigneeId),
      clientById(shipment.shipToId),
      clientById(shipment.carrierId),
      config.forwarderClientId ? prisma.client.findUnique({ where: { clientId: config.forwarderClientId } }) : null,
      prisma.cargoContainer.findMany({
        where: { shipmentId: shipment.id },
        include: { items: { orderBy: { id: "asc" } } },
        orderBy: { id: "asc" },
      }),
      // Export port: 4 digits.
      portCodeFor([shipment.placeOfReceipt, shipment.origin], /^\d{4}$/),
      // Unloading port: 4 or 5 digits.
      portCodeFor([shipment.placeOfDelivery, shipment.destination], /^\d{4,5}$/),
    ]);

  const responseEmail = [opts.userEmail ?? "", config.notifyEmail].map((e) => e.trim()).filter(Boolean).join(",");

  const mapping = buildWeblinkFields({
    shipment: {
      fileNumber: shipment.fileNumber,
      domesticType: shipment.domesticType,
      zohoLayoutName: shipment.zohoLayoutName,
      serviceType: shipment.serviceType,
      bolNumber: shipment.bolNumber,
      proNumber: shipment.proNumber,
      country: shipment.country,
      destination: shipment.destination,
      placeOfReceipt: shipment.placeOfReceipt,
      origin: shipment.origin,
      placeOfDelivery: shipment.placeOfDelivery,
      shipAt: shipment.shipAt,
      preferredPickupAt: shipment.preferredPickupAt,
      pickupScheduleAt: shipment.pickupScheduleAt,
      etaAt: shipment.etaAt,
      cargoDescription: shipment.cargoDescription,
      carrierPicklist: shipment.carrierPicklist,
      zohoAwb,
    },
    shipper: toParty(shipper),
    account: toParty(account),
    consignee: toParty(consignee),
    shipTo: toParty(shipTo),
    carrier: toParty(carrier),
    forwarder: toParty(forwarder),
    filerId: config.filerId,
    containers: containers.map((c) => ({
      containerNumber: c.containerNumber,
      seal1: c.seal1,
      items: c.items.map((i) => ({
        id: i.id,
        description: i.description,
        numberOfPieces: i.numberOfPieces,
        pieceType: i.pieceType,
        grossWeightLbs: i.grossWeightLbs,
        grossWeightKgs: i.grossWeightKgs,
        declaredValueCents: i.declaredValueCents,
        isVehicle: i.isVehicle,
        vehicleMake: i.vehicleMake,
        vehicleModel: i.vehicleModel,
        vehicleTitle: i.vehicleTitle,
        vehicleState: i.vehicleState,
      })),
    })),
    portOfExportCode,
    portOfUnladingCode,
    responseEmail,
    successUrl: aesReturnUrl(opts.baseUrl, "success", fileNumber, opts.nonce),
    failureUrl: aesReturnUrl(opts.baseUrl, "failure", fileNumber, opts.nonce),
    today: opts.now ?? new Date(),
    details: details?.details ?? null,
  });

  // Status check. CBP only returns to https URLs.
  let inquiry: AesHandoff["inquiry"] = null;
  if (config.filerId) {
    const statusUrl = aesReturnUrl(opts.baseUrl, "status", fileNumber, opts.nonce);
    const returnsToTms = statusUrl.startsWith("https://");
    inquiry = {
      fields: { FID: config.filerId, SRN: mapping.srn, ...(returnsToTms ? { URL: statusUrl } : {}) },
      returnsToTms,
    };
  }

  return { fileNumber, shipmentId: shipment.id, fieldsHash: fieldsHash(mapping.fields), config, mapping, inquiry, details };
}
