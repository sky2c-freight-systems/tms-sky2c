import { createHash } from "crypto";
import type { DomesticWarehouseShipment } from "@prisma/client";
import { asZohoFields } from "@/lib/shipmentLayoutFields";

/**
 * Everything printed on the Pickup Bill of Lading (templates/pickupBol.ts), resolved from a
 * Dispatch shipment's fields. Kept as plain data so it can be hashed: auto-generation only
 * saves a new version when this changes.
 *
 * Where each box comes from depends on the Dispatch layout:
 *   - Dispatch to Warehouse: Pickup Location -> Warehouse Location
 *   - Dispatch to Port:      Pickup Location -> Port Drop Location
 *   - Warehouse to Port:     Warehouse Location -> Port Drop Location
 */
export interface PickupBolData {
  reference: string;
  carrier: string;
  /** "Special Handling" box lines. */
  specialHandling: string[];
  /** "Remarks" box lines. */
  remarks: string[];
  shipper: string;
  consignee: string;
  customerRef: string;
  rows: PickupBolRow[];
}

export interface PickupBolRow {
  units: string;
  hazmat: string;
  description: string;
  weight: string;
  dimensions: string;
}

/** Display time zone for the BOL's date/times; Sky2C's US dispatch runs on Pacific time. */
const BOL_TIME_ZONE = process.env.BOL_TIME_ZONE || "America/Los_Angeles";

function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOL_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function fmt3(n: number): string {
  return n.toFixed(3);
}

/**
 * "Pallets x Dimensions" text ("1@80x9x9", one or more per line, any separators) -> cargo
 * rows, one per N@LxWxH group — the same token format the Zoho volumetric-weight function
 * parses. The commodity and total gross weight go on the first row, as on the paper BOL.
 */
/**
 * HM (hazardous materials) column: "YES" when Zoho's Stackable and Turnable
 * (cf_stackable_and_turnable) includes "Hazardous/DG", otherwise "NO".
 */
function hazmatFlag(stackableTurnable: string[]): string {
  return stackableTurnable.some((v) => v.trim().toLowerCase() === "hazardous/dg") ? "YES" : "NO";
}

function cargoRows(pallets: string, commodity: string, grossWeight: number | null, hazmat: string): PickupBolRow[] {
  const groups = [...pallets.matchAll(/(\d+)\s*@\s*([\d.]+)\s*[x*]\s*([\d.]+)\s*[x*]\s*([\d.]+)/gi)];
  const weight = grossWeight !== null ? `${grossWeight} LBS` : "";
  if (groups.length === 0) {
    if (!commodity && !weight && !pallets.trim()) return [];
    return [{ units: "", hazmat, description: commodity, weight, dimensions: pallets.trim() }];
  }
  return groups.map((g, i) => ({
    units: g[1],
    hazmat,
    description: i === 0 ? commodity : "",
    weight: i === 0 ? weight : "",
    dimensions: `${g[1]} @ ${fmt3(Number(g[2]))} x ${fmt3(Number(g[3]))} x ${fmt3(Number(g[4]))} IN`,
  }));
}

export function buildPickupBolData(
  shipment: DomesticWarehouseShipment,
  carrierClientName: string | null
): PickupBolData {
  const zf = asZohoFields(shipment.zohoFields);
  const layout = shipment.zohoLayoutName ?? "";
  const portDrop = str(zf.cf_port_drop_location);
  const warehouse = str(shipment.warehouseLocation);
  const pickup = str(shipment.placeOfReceipt);

  const fromWarehouse = layout === "Warehouse to Port";
  const toPort = layout === "Dispatch to Port" || layout === "Warehouse to Port";

  // The picklist wins unless it's a placeholder; "Other" means the free-text Carrier field.
  const picklist = str(shipment.carrierPicklist);
  const carrier = picklist && !["other", "na"].includes(picklist.toLowerCase()) ? picklist : str(carrierClientName);

  const contact = str(shipment.contactDetails);
  const remarks: string[] = [];
  if (str(shipment.dockHours)) remarks.push(`DOCK HOURS : ${str(shipment.dockHours)}`);
  if (str(shipment.soNumber)) remarks.push(`SO NUMBER : ${str(shipment.soNumber)}`);
  const preferred = formatDateTime(shipment.preferredPickupAt);
  if (preferred) remarks.push(`PREFERRED PICKUP DATE : ${preferred}`);
  const instructions = fromWarehouse ? str(zf.cf_warehouse_pickup_instructions) : str(shipment.pickupInstructions);
  if (instructions && !/^(na|no|n\/a|none)$/i.test(instructions)) remarks.push(`PICKUP INSTRUCTIONS : ${instructions}`);

  return {
    reference: str(zf.cf_ref_number) || shipment.fileNumber,
    carrier,
    specialHandling: contact ? ["CONTACT DETAILS :", ...contact.split(/\r?\n/)] : [],
    remarks,
    shipper: fromWarehouse ? warehouse : pickup,
    consignee: toPort ? portDrop : warehouse,
    // Not mapped to any Zoho field — printed blank, as on the paper BOL.
    customerRef: "",
    rows: cargoRows(
      str(shipment.palletsDimensions),
      str(shipment.cargoDescription),
      shipment.grossWeight,
      hazmatFlag(shipment.stackableTurnable ?? [])
    ),
  };
}

/**
 * Fields the BOL needs before it can be generated, by their Zoho labels; returns the ones
 * that are empty (in layout order). Customer Ref. No. (always blank) and Pickup
 * Instructions are optional — the paper BOL is issued without them.
 */
export function missingPickupBolFields(shipment: DomesticWarehouseShipment, carrierClientName: string | null): string[] {
  const zf = asZohoFields(shipment.zohoFields);
  const layout = shipment.zohoLayoutName ?? "";
  const fromWarehouse = layout === "Warehouse to Port";
  const toPort = layout === "Dispatch to Port" || layout === "Warehouse to Port";
  const picklist = str(shipment.carrierPicklist);
  const hasCarrier = (!!picklist && !["other", "na"].includes(picklist.toLowerCase())) || !!str(carrierClientName);

  const required: [string, boolean][] = [
    ["Ref Number", !!str(zf.cf_ref_number)],
    [picklist.toLowerCase() === "other" ? "Carrier" : "Carrier-Name", hasCarrier],
    ["Contact Details", !!str(shipment.contactDetails)],
    ["Dock Hours", !!str(shipment.dockHours)],
    ["SO Number", !!str(shipment.soNumber)],
    ["Preferred Pickup Date", !!shipment.preferredPickupAt],
    [fromWarehouse ? "Warehouse Location" : "Pickup Location", !!str(fromWarehouse ? shipment.warehouseLocation : shipment.placeOfReceipt)],
    [toPort ? "Port Drop Location" : "Warehouse Location", !!str(toPort ? zf.cf_port_drop_location : shipment.warehouseLocation)],
    ["Pallets x Dimensions", !!str(shipment.palletsDimensions)],
    ["Commodity Detail", !!str(shipment.cargoDescription)],
    ["Gross Weight", shipment.grossWeight !== null && shipment.grossWeight !== undefined],
  ];
  return [...new Set(required.filter(([, ok]) => !ok).map(([label]) => label))];
}

export function hashPickupBolData(data: PickupBolData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
