import type { DomesticWarehouseShipment } from "@prisma/client";
import { asZohoFields } from "@/lib/shipmentLayoutFields";

/**
 * Everything printed on the House Air Waybill (templates/hawb.ts), resolved from an Air Ops
 * (parent) shipment. Boxes with no Shipment/Zoho field behind them are printed blank —
 * see NOT_MAPPED in templates/hawb.ts for the list.
 *
 * Weights: Zoho's Gross / Chargeable Weight are in lbs (the volumetric formula on the
 * tickets divides cubic inches by 166), while an air waybill is issued in kg, so both are
 * converted.
 */
export interface HawbData {
  /** Master AWB line, e.g. "098 ORD 32105640". */
  masterAwb: string;
  hawbNumber: string;
  issuedBy: string;
  shipper: string;
  /** TMS Client ID of the shipment's Shipper client. */
  shipperCode: string;
  consignee: string;
  /** TMS Client ID of the shipment's Consignee client. */
  consigneeCode: string;
  departureAirport: string;
  destinationAirport: string;
  destinationCountry: string;
  currency: string;
  pieces: string;
  grossWeightKg: string;
  chargeableWeightKg: string;
  volumeM3: string;
  /** Nature and Quantity of Goods lines. */
  goods: string[];
  executedOn: string;
  signedBy: string;
}

const LB_TO_KG = 0.45359237;
const CUBIC_IN_TO_M3 = 0.000016387064;

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function kg(lbs: number | null | undefined): number | null {
  return lbs === null || lbs === undefined || lbs <= 0 ? null : lbs * LB_TO_KG;
}

/** "N@LxWxH" groups (inches), the same token format the BOL and Zoho's weight function use. */
function palletGroups(pallets: string) {
  return [...pallets.matchAll(/(\d+)\s*@\s*([\d.]+)\s*[x*]\s*([\d.]+)\s*[x*]\s*([\d.]+)/gi)].map((g) => ({
    n: Number(g[1]),
    l: Number(g[2]),
    w: Number(g[3]),
    h: Number(g[4]),
  }));
}

/** "105-62095305" -> "105 ORD 62095305" (airline prefix, departure airport, serial). */
function formatMasterAwb(awb: string, origin: string): string {
  const m = /^(\d{3})\s*[-\s]?\s*(\d{4}\s*\d{4})$/.exec(awb);
  if (!m) return awb;
  return [m[1], origin, m[2].replace(/\s/g, "")].filter(Boolean).join(" ");
}

/** "21-OCT-26", as printed in the Executed on box. */
function executedDate(d: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

/** Client IDs of the shipment's Shipper / Consignee clients, printed as the HAWB codes. */
export interface HawbPartyCodes {
  shipperCode: string | null;
  consigneeCode: string | null;
}

export function buildHawbData(
  shipment: DomesticWarehouseShipment,
  signedBy: string | null,
  codes: HawbPartyCodes,
  now = new Date()
): HawbData {
  const zf = asZohoFields(shipment.zohoFields);
  const origin = str(shipment.origin);
  const ref = str(zf.cf_ref_number);
  const pallets = str(shipment.palletsDimensions);
  const groups = palletGroups(pallets);

  const pieces = groups.reduce((sum, g) => sum + g.n, 0);
  const volume = groups.reduce((sum, g) => sum + g.n * g.l * g.w * g.h * CUBIC_IN_TO_M3, 0);
  const gross = kg(shipment.grossWeight);
  // Chargeable weight is never below gross; Zoho sometimes leaves it 0.
  const chargeableRaw = kg(shipment.chargeableWeight);
  const chargeable = chargeableRaw !== null && gross !== null ? Math.max(chargeableRaw, gross) : (chargeableRaw ?? gross);

  const goods = [str(shipment.cargoDescription)].filter(Boolean);
  if (groups.length) goods.push(...groups.map((g) => `${g.n} @ ${g.l}x${g.w}x${g.h} IN`));
  else if (pallets) goods.push(pallets);

  return {
    masterAwb: formatMasterAwb(str(zf.cf_awb), origin),
    // Zoho's HAWB field when set, else the house-bill convention Ref Number + "-01".
    hawbNumber: str(zf.cf_hawb) || (ref ? `${ref}-01` : shipment.fileNumber),
    issuedBy: str(shipment.carrierPicklist).toUpperCase(),
    shipper: str(shipment.placeOfReceipt),
    shipperCode: str(codes.shipperCode),
    consignee: str(zf.cf_consignee_details) || str(zf.cf_destination_address),
    consigneeCode: str(codes.consigneeCode),
    departureAirport: origin,
    destinationAirport: str(shipment.destination),
    destinationCountry: str(shipment.country).toUpperCase(),
    currency: str(zf.cf_currency_type) || "USD",
    pieces: pieces ? String(pieces) : "",
    grossWeightKg: gross !== null ? gross.toFixed(1) : "",
    chargeableWeightKg: chargeable !== null ? chargeable.toFixed(1) : "",
    volumeM3: volume > 0 ? volume.toFixed(3) : "",
    goods,
    executedOn: executedDate(now),
    signedBy: str(signedBy).toUpperCase(),
  };
}
