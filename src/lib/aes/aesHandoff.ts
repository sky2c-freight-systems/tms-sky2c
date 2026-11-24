import type { Client } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { escapeRegex } from "@/lib/mongoText";
import { getAesConfig, SKY2C_AGENT, type AesConfig } from "@/lib/aes/config";
import { buildWeblinkFields, type AesLocation, type AesMappingResult, type AesParty } from "@/lib/aes/weblinkFields";
import { fieldsHash } from "@/lib/aes/audit";
import { asZohoFields } from "@/lib/shipmentLayoutFields";
import { parsePlaceText } from "@/lib/aes/places";
import { toUsStateCode } from "@/lib/aes/codes";

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
    idNumber: c.exporterIdNumber,
    idType: c.exporterIdType,
    scac: c.scacCode,
  };
}

// Finds the Location a search field points at: exact name, then code, then city/name match.
// Falls back to what the text itself says ("Los Angeles, CA", "Oakland (2811)").
async function resolvePlace(raw: string | null | undefined, foreign = false): Promise<AesLocation | null> {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const parsed = parsePlaceText(text, { foreign });
  const select = { name: true, code: true, state: true, country: true } as const;
  const exact = (v: string) => ({ equals: escapeRegex(v), mode: "insensitive" as const });

  let found = await prisma.location.findFirst({ where: { name: exact(text), isActive: true }, select });
  if (!found && parsed.portCode) {
    found = await prisma.location.findFirst({ where: { code: exact(parsed.portCode), isActive: true }, select });
  }
  if (!found && parsed.head) {
    const candidates = await prisma.location.findMany({
      where: { isActive: true, OR: [{ name: exact(parsed.head) }, { city: exact(parsed.head) }, { code: exact(parsed.head) }] },
      select,
      take: 10,
    });
    const fits = parsed.state ? candidates.filter((c) => !c.state || toUsStateCode(c.state) === parsed.state) : candidates;
    // Only take it when the match is unambiguous (same port code and state).
    const same = (c: (typeof fits)[number]) => (c.code ?? "") === (fits[0].code ?? "") && toUsStateCode(c.state) === toUsStateCode(fits[0].state);
    if (fits.length === 1 || (fits.length > 1 && fits.every(same))) found = fits[0];
  }
  if (found) {
    // Prefer a CBP port code (4-5 digits) over another kind of code such as a UN/LOCODE.
    const isPortCode = (v: string | null | undefined) => /^\d{4,5}$/.test(v ?? "");
    return {
      name: found.name,
      code: (isPortCode(found.code) ? found.code : parsed.portCode) || found.code || null,
      state: found.state || parsed.state || null,
      country: found.country || parsed.country || null,
      matched: true,
    };
  }
  return { name: text, code: parsed.portCode || null, state: parsed.state || null, country: parsed.country || null, matched: false };
}

async function clientById(id: string | null | undefined): Promise<Client | null> {
  if (!id) return null;
  return prisma.client.findUnique({ where: { id } });
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
  const zoho = asZohoFields(shipment.zohoFields);
  const zohoText = (v: unknown) => (typeof v === "string" ? v : null);

  const [shipper, account, consignee, shipTo, carrier, forwarder, containers, pickupLocation, originPort, destinationPort] =
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
      resolvePlace(shipment.placeOfReceipt),
      resolvePlace(shipment.origin),
      resolvePlace(shipment.destination, true),
    ]);
  // Export port: 4 digits (Schedule D). Unloading port: 4-5 digits (Schedule K/D).
  const portOfExportCode = /^\d{4}$/.test(originPort?.code ?? "") ? originPort!.code! : "";
  const portOfUnladingCode = /^\d{4,5}$/.test(destinationPort?.code ?? "") ? destinationPort!.code! : "";

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
      grossWeightLbs: shipment.grossWeight,
      carrierPicklist: shipment.carrierPicklist,
      zohoAwb: zohoText(zoho.cf_awb),
      consigneeDetails: zohoText(zoho.cf_consignee_details),
      palletsDimensions: shipment.palletsDimensions,
    },
    shipper: toParty(shipper),
    account: toParty(account),
    consignee: toParty(consignee),
    shipTo: toParty(shipTo),
    carrier: toParty(carrier),
    // Sky2C client record if set up, else the built-in Sky2C details.
    forwarder: toParty(forwarder) ?? { ...SKY2C_AGENT },
    filerId: config.filerId,
    containers: containers.map((c) => ({
      containerNumber: c.containerNumber,
      seal1: c.seal1,
      items: c.items.map((i) => ({
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
    pickupLocation,
    originPort,
    destinationPort,
    responseEmail,
    successUrl: aesReturnUrl(opts.baseUrl, "success", fileNumber, opts.nonce),
    failureUrl: aesReturnUrl(opts.baseUrl, "failure", fileNumber, opts.nonce),
    today: opts.now ?? new Date(),
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

  return { fileNumber, shipmentId: shipment.id, fieldsHash: fieldsHash(mapping.fields), config, mapping, inquiry };
}
