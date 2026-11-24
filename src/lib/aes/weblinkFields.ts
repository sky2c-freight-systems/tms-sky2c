import {
  formatAesDate,
  MOT_LABELS,
  toAesPersonName,
  toAesPhone,
  toAesPostalCode,
  toAesText,
  toCountryCode,
  toSrn,
  toUsStateCode,
} from "@/lib/aes/codes";
import { findExportPort, findUnladingPort, isAirportPlace } from "@/lib/aes/portCodes";
import { airlineFromAwb } from "@/lib/aes/airlines";
import { parsePartyText } from "@/lib/aes/partyText";
import { DOMESTIC_TYPE_LABELS } from "@/lib/enumLabels";

export interface AesParty {
  clientId: string;
  name: string;
  street: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  telephone: string | null;
  contact: string | null;
  contactLastName: string | null;
  idNumber?: string | null;
  idType?: string | null;
  scac?: string | null;
}

export interface AesLocation {
  name: string;
  code: string | null;
  state: string | null;
  country: string | null;
  matched?: boolean;
}

export interface AesCargoItem {
  description: string | null;
  numberOfPieces: number | null;
  pieceType: string | null;
  grossWeightLbs: number | null;
  grossWeightKgs: number | null;
  declaredValueCents: number | null;
  isVehicle: boolean;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleTitle: string | null;
  vehicleState: string | null;
}

export interface AesContainer {
  containerNumber: string | null;
  seal1: string | null;
  items: AesCargoItem[];
}

export interface AesShipmentInput {
  fileNumber: string;
  domesticType: string;
  zohoLayoutName: string | null;
  serviceType: string | null;
  bolNumber: string | null;
  proNumber: string | null;
  country: string | null;
  destination: string | null;
  placeOfReceipt: string | null;
  origin: string | null;
  placeOfDelivery: string | null;
  shipAt: Date | null;
  preferredPickupAt: Date | null;
  pickupScheduleAt: Date | null;
  etaAt: Date | null;
  cargoDescription: string | null;
  grossWeightLbs?: number | null;
  carrierPicklist: string | null;
  zohoAwb?: string | null;
  consigneeDetails?: string | null;
  palletsDimensions?: string | null;
}

export interface AesMappingInput {
  shipment: AesShipmentInput;
  shipper: AesParty | null;
  account: AesParty | null;
  consignee: AesParty | null;
  shipTo: AesParty | null;
  carrier: AesParty | null;
  forwarder: AesParty | null;
  filerId: string;
  containers: AesContainer[];
  portOfExportCode: string;
  portOfUnladingCode: string;
  pickupLocation?: AesLocation | null;
  originPort?: AesLocation | null;
  destinationPort?: AesLocation | null;
  responseEmail: string;
  successUrl: string;
  failureUrl: string;
  today: Date;
}

export type MappingStatus = "mapped" | "derived" | "missing" | "not-in-tms" | "warning";

export interface MappingRow {
  group: string;
  code: string;
  label: string;
  value: string;
  source: string;
  status: MappingStatus;
  required: boolean;
  note?: string;
}

export interface AesMappingResult {
  srn: string;
  fields: Record<string, string>;
  rows: MappingRow[];
  advisories: string[];
  lineCount: number;
  counts: Record<MappingStatus, number>;
}

const MAX_DESCRIPTION = 45;
const MAX_SRN = 17;
const MAX_LINES = 99;
const LBS_TO_KG = 0.45359237;
const LOW_VALUE_THRESHOLD_USD = 2500;

function line1(p: AesParty): string {
  return toAesText(p.street) || toAesText(p.addressLine1);
}

function line2(p: AesParty): string {
  return toAesText(p.street) ? toAesText(p.addressLine2) || toAesText(p.addressLine1) : toAesText(p.addressLine2);
}

function partyStateCode(p: AesParty, countryCode: string): { value: string; note?: string } {
  const raw = toAesText(p.state);
  if (!raw) return { value: "" };
  if (countryCode === "US" || !countryCode) {
    const code = toUsStateCode(raw);
    return code ? { value: code } : { value: "", note: `"${raw}" is not a recognizable US state` };
  }
  if ((countryCode === "CA" || countryCode === "MX") && /^[A-Za-z]{2}$/.test(raw)) return { value: raw.toUpperCase() };
  return { value: "", note: `"${raw}" not sent — AES state codes apply to US/Canada/Mexico addresses` };
}

function contactNames(p: AesParty): { first: string; last: string; split: boolean } {
  const first = toAesPersonName(p.contact);
  const last = toAesPersonName(p.contactLastName);
  if (last || !first.includes(" ")) return { first, last, split: false };
  const cut = first.lastIndexOf(" ");
  return { first: toAesPersonName(first.slice(0, cut)), last: toAesPersonName(first.slice(cut + 1)), split: true };
}

function sameParty(a: AesParty | null, b: AesParty | null): boolean {
  if (!a || !b) return false;
  if (a.clientId && a.clientId === b.clientId) return true;
  const key = (v: string) => toAesText(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return !!key(a.name) && key(a.name) === key(b.name);
}

export function deriveModeOfTransport(
  s: AesShipmentInput,
  hasContainers: boolean,
  ctx: { destinationCountry?: string; originPort?: AesLocation | null } = {}
): { code: string; reason: string } {
  const label = DOMESTIC_TYPE_LABELS[s.domesticType] ?? s.domesticType;
  const c = hasContainers;
  if (s.domesticType === "DOMESTIC_AIR") return { code: c ? "41" : "40", reason: `Domestic Type (${label})` };
  const dest = ctx.destinationCountry ?? "";
  if (!dest || dest === "CA" || dest === "MX" || dest === "US") {
    const to = dest === "CA" || dest === "MX" ? `, destination ${dest}` : "";
    if (s.domesticType === "RAIL" || s.domesticType === "MOTOR_RAIL") return { code: c ? "21" : "20", reason: `Domestic Type (${label})${to}` };
    if (s.domesticType === "TRUCK" || s.domesticType === "TRUCK_TEAM") return { code: c ? "31" : "30", reason: `Domestic Type (${label})${to}` };
    return { code: c ? "31" : "30", reason: label ? `Default Truck (Domestic Type "${label}" has no AES match)${to}` : `Default Truck (no Domestic Type)${to}` };
  }
  if (isAirportPlace(ctx.originPort)) return { code: c ? "41" : "40", reason: `Origin Port is an airport; destination ${dest} isn't Canada/Mexico` };
  if (toAesText(s.zohoAwb)) return { code: c ? "41" : "40", reason: `AWB on the shipment; destination ${dest} isn't Canada/Mexico` };
  return { code: c ? "11" : "10", reason: `Leaves by ship: destination ${dest} isn't Canada/Mexico and the Origin Port isn't an airport` };
}

function palletPieces(text: string | null | undefined): number {
  return [...(text ?? "").matchAll(/(\d+)\s*@/g)].reduce((sum, m) => sum + Number(m[1]), 0);
}

export function buildWeblinkFields(input: AesMappingInput): AesMappingResult {
  const fields: Record<string, string> = {};
  const rows: MappingRow[] = [];
  const advisories: string[] = [];
  const { shipment: s } = input;

  function put(
    group: string,
    code: string,
    label: string,
    value: string,
    source: string,
    opts: { required?: boolean; derived?: boolean; notInTms?: boolean; note?: string; warning?: boolean } = {}
  ) {
    const v = toAesText(value);
    let status: MappingStatus;
    if (opts.notInTms && !v) status = "not-in-tms";
    else if (!v) status = "missing";
    else if (opts.warning) status = "warning";
    else if (opts.derived) status = "derived";
    else status = "mapped";
    if (v) fields[code] = v;
    rows.push({ group, code, label, value: v, source, status, required: !!opts.required, note: opts.note });
  }

  put("System", "wl_success_url", "Success return URL", input.successUrl, "TMS");
  put("System", "wl_nosed_url", "Failure return URL", input.failureUrl, "TMS");
  put("System", "EMAIL", "Response email", input.responseEmail, "Your email (+ the company notification email, if set)");

  const srnFull = toSrn(s.fileNumber);
  const srn = srnFull.slice(0, MAX_SRN);
  const srnChanged = srn !== s.fileNumber;
  put("Shipment", "SRN", "Shipment Reference Number", srn, "File Number", {
    required: true,
    warning: srnFull.length > MAX_SRN,
    note: srnFull.length > MAX_SRN
      ? `Truncated to ${MAX_SRN} characters`
      : srnChanged
        ? `AES allows letters/digits only — "${s.fileNumber}" is sent as "${srn}"`
        : "Unique per shipment — never reused; corrections resend this SRN as a Replace",
  });
  put("Shipment", "FAC", "Filing action", "A", "Chosen on this page", {
    required: true,
    note: "Add = first filing for this SRN; Replace = correct an accepted filing (same SRN)",
  });
  put("Shipment", "FO", "Filing option", "2", "Default", {
    required: true,
    derived: true,
    note: "2 = Predeparture (the AESDirect default). Option 4 (postdeparture) needs CBP approval",
  });

  const ultimate = input.consignee;
  const zc = ultimate && line1(ultimate) ? null : parsePartyText(s.consigneeDetails);
  const ZC_SOURCE = "Zoho Consignee Details (read from the text)";
  const recordCountry = toCountryCode(ultimate?.country);
  const textCountry = zc?.country ?? "";
  const ultimateCountry = recordCountry || textCountry;
  const destPortCountry = toCountryCode(input.destinationPort?.country);
  const cod = ultimateCountry || destPortCountry || toCountryCode(s.country);

  const hasContainers = input.containers.some((c) => toAesText(c.containerNumber));
  const mot = deriveModeOfTransport(s, hasContainers, { destinationCountry: cod, originPort: input.originPort });
  const air = mot.code.startsWith("4");
  const vessel = mot.code.startsWith("1");

  const awb = toAesText(s.zohoAwb);
  const pro = toAesText(s.proNumber);
  const bol = toAesText(s.bolNumber);
  const bn = air ? awb : vessel ? "" : pro || bol;
  put("Shipment", "BN", "Transportation reference (AWB/PRO/BOL)", bn,
    air ? "AWB" : vessel ? "Ocean carrier's booking number" : pro ? "PRO Number" : bol ? "BOL Number" : "PRO / BOL Number", {
      note: bn ? undefined
        : air ? "No AWB on the shipment: fill in AESDirect"
        : vessel ? "Fill in AESDirect: the ocean carrier's booking number"
        : "No PRO or BOL number on the shipment: fill in AESDirect",
    });

  const usppi = input.account;
  const usppiCountry = usppi ? toCountryCode(usppi.country) || "US" : "US";
  const usppiState = usppi ? toUsStateCode(usppi.state) : "";

  const pickupState = toUsStateCode(input.pickupLocation?.state);
  const portState = toUsStateCode(input.originPort?.state);
  const originState = pickupState || portState;
  const fromText = (l?: AesLocation | null) => (l && l.matched === false ? ", from the text" : "");
  put("Shipment", "ST", "U.S. state of origin", originState,
    pickupState ? `Pickup Location state ("${toAesText(input.pickupLocation?.state)}"${fromText(input.pickupLocation)})`
      : portState ? `Origin Port state ("${toAesText(input.originPort?.state)}"${fromText(input.originPort)})`
      : "Pickup Location / Origin Port state", {
      required: true,
      note: originState ? undefined : "No US state found for the Pickup Location or Origin Port",
    });

  const listedPort = input.portOfExportCode ? null : findExportPort(input.originPort, mot.code);
  const poe = input.portOfExportCode || listedPort?.code || "";
  const originName = toAesText(input.originPort?.name);
  put("Shipment", "POE", "Port of export (Schedule D)", poe,
    input.portOfExportCode ? `Origin Port (location code${fromText(input.originPort)})`
      : listedPort ? `Origin Port "${originName}" = ${listedPort.name} (built-in Schedule D list)`
      : "Origin Port", {
      required: true,
      derived: !!listedPort,
      note: input.portOfExportCode ? undefined
        : listedPort ? "Matched by port name, please confirm"
        : originName ? `No Schedule D code found for "${originName}"${mot.code ? "" : " (mode of transport unknown)"}: pick the port in AESDirect`
        : "No Origin Port on the shipment: pick the port in AESDirect",
    });

  put("Shipment", "COD", "Country of ultimate destination", cod,
    recordCountry ? `Consignee country ("${toAesText(ultimate?.country)}")`
      : textCountry ? ZC_SOURCE
      : destPortCountry ? `Destination Port country ("${toAesText(input.destinationPort?.country)}"${fromText(input.destinationPort)})`
      : `Shipment country ("${toAesText(s.country)}")`, {
      required: true,
      derived: !recordCountry && !!textCountry,
      warning: cod === "US",
      note: cod === "US" ? "Destination is the US — AES applies to exports only" : undefined,
    });
  if (cod === "US") advisories.push("The destination is the US. AES filings are only for exports. Check the consignee or shipment country.");
  if (cod === "CA") advisories.push("Destination is Canada. Most exports to Canada don't need an AES filing unless a license is needed. Check before filing.");

  const listedPou = input.portOfUnladingCode ? null : findUnladingPort(input.destinationPort, mot.code);
  const pou = input.portOfUnladingCode || listedPou?.code || "";
  const destName = toAesText(input.destinationPort?.name);
  put("Shipment", "POU", "Port of unlading", pou,
    input.portOfUnladingCode ? `Destination Port (location code${fromText(input.destinationPort)})`
      : listedPou ? `Destination Port "${destName}" = ${listedPou.name} (built-in Schedule K list)`
      : "Destination Port", {
      derived: !!listedPou,
      note: pou ? (listedPou ? "Matched by port name, please confirm" : undefined) : "Needed for vessel exports only: pick it in AESDirect",
    });

  const exportDate = s.shipAt ?? s.pickupScheduleAt ?? s.preferredPickupAt ?? s.etaAt;
  const exportDateSource = s.shipAt ? "Pickup Date" : s.pickupScheduleAt ? "Pickup Schedule Time" : s.preferredPickupAt ? "Preferred Pickup Date" : "ETA";
  const startOfToday = Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate());
  const inPast = !!exportDate && exportDate.getTime() < startOfToday;
  put("Shipment", "EDA", "Estimated date of export", formatAesDate(exportDate), exportDateSource, {
    required: true,
    warning: inPast,
    note: inPast ? "Date is in the past — predeparture filings need a current/future export date" : undefined,
  });

  put("Shipment", "MOT", "Mode of transportation", mot.code, mot.reason, {
    required: true,
    derived: true,
    note: `${MOT_LABELS[mot.code]}. AES wants the mode the goods leave the US on: change it in AESDirect if it differs`,
  });

  const airline = air ? airlineFromAwb(s.zohoAwb) : null;
  const carrierName = vessel ? "" : toAesText(input.carrier?.name) || toAesText(s.carrierPicklist);
  const carrierSource = toAesText(input.carrier?.name) ? "Carrier" : "Carrier-Name (Zoho)";
  const scac = toAesText(input.carrier?.scac).toUpperCase();
  const carrierScac = !vessel && /^[A-Z]{2,4}$/.test(scac) ? scac : "";
  put("Shipment", "SCAC", air ? "Carrier IATA code" : "Carrier SCAC code",
    air ? airline?.iata ?? "" : carrierScac,
    air ? (airline ? `AWB prefix ${airline.prefix} (${airline.name})` : "AWB prefix")
      : vessel ? "Ocean carrier"
      : carrierScac ? "Carrier (SCAC on the client record)" : "Carrier", {
      required: true,
      notInTms: true,
      derived: air,
      note: air
        ? airline ? "From the AWB number, please confirm" : awb ? "AWB prefix isn't in the built-in airline list: fill in AESDirect" : "No AWB on the shipment: fill in AESDirect"
        : vessel ? "Fill in AESDirect: the ocean carrier's SCAC (the TMS Carrier is the pickup trucker)"
        : carrierScac ? undefined
        : input.carrier ? "Add the SCAC on the Carrier's client record, or fill in AESDirect"
        : "No Carrier on the shipment: fill in AESDirect",
    });
  put("Shipment", "VN", "Conveyance / carrier name", air ? airline?.name ?? "" : carrierName,
    air ? (airline ? `AWB prefix ${airline.prefix}` : "Airline") : vessel ? "Vessel name" : carrierName ? carrierSource : "Carrier", {
      required: true,
      notInTms: true,
      derived: air,
      note: air
        ? airline ? "Airline from the AWB number, please confirm" : "Fill in AESDirect: the airline name"
        : vessel ? "Fill in AESDirect: the vessel name"
        : carrierName ? undefined : "No Carrier on the shipment: fill in AESDirect",
    });

  const related = sameParty(usppi, ultimate);
  put("Shipment", "RCC", "Related company indicator", related ? "Y" : "N", related ? "Account and Consignee are the same client" : "Account vs Consignee", {
    required: true,
    derived: true,
    note: related ? "Same party, so related" : "N = not related. Use Y if either party owns 10% or more of the other",
  });
  put("Shipment", "HAZ", "Hazardous material indicator", "N", "Default (No)", { required: true });
  put("Shipment", "RT", "Routed export transaction", "N", "Default (No)", { required: true });

  put("Shipment", "IBT", "In-bond code", "70", "Domestic warehouse (not in bond)", { note: "70 = Not in bond" });

  const usppiSource = "Account";
  put("USPPI (exporter)", "AD0_1", "Name", toAesText(usppi?.name), usppiSource, { required: true });
  const idFromClient = (usppi?.idNumber ?? "").replace(/[\s.-]/g, "").toUpperCase();
  const exporterId = /^[A-Z0-9]{9,11}$/.test(idFromClient) ? idFromClient : "";
  put("USPPI (exporter)", "AD0_2", "ID (EIN)", exporterId, exporterId ? "Account (EIN)" : usppiSource, {
    required: true,
    notInTms: true,
    note: exporterId ? undefined
      : idFromClient ? `Account EIN "${toAesText(usppi?.idNumber)}" isn't 9-11 letters/digits`
      : "Add the EIN on the Account's client record, or fill in AESDirect",
  });
  const typeFromClient = ["E", "D", "T"].includes(toAesText(usppi?.idType)) ? toAesText(usppi?.idType) : "";
  const exporterIdType = typeFromClient || (exporterId ? "E" : "");
  put("USPPI (exporter)", "AD0_3", "ID type", exporterIdType,
    typeFromClient ? "Account (EIN type)" : exporterId ? "Default (EIN)" : usppiSource, {
      required: true,
      notInTms: true,
      note: "EIN / DUNS / Foreign entity ID",
    });
  if (usppi) {
    if (usppiCountry !== "US") {
      advisories.push(`The exporter (${toAesText(usppi.name)}) has a non-US address. The exporter must be a US company. Check the Account.`);
    }
    put("USPPI (exporter)", "AD0_4", "Address line 1", line1(usppi), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_5", "Address line 2", line2(usppi), usppiSource);
    put("USPPI (exporter)", "AD0_6", "City", toAesText(usppi.city), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_7", "State", usppiState, usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_8", "Postal code", toAesPostalCode(usppi.zipCode, "US"), usppiSource, {
      required: true,
      note: toAesText(usppi.zipCode) && !toAesPostalCode(usppi.zipCode, "US") ? `"${toAesText(usppi.zipCode)}" isn't a 5/9-digit US ZIP` : undefined,
    });
    const names = contactNames(usppi);
    const nameSource = names.split ? "Account contact (full name split)" : usppiSource;
    put("USPPI (exporter)", "AD0_9", "Contact first name", names.first, nameSource, { required: true, derived: names.split });
    put("USPPI (exporter)", "AD0_11", "Contact last name", names.last, nameSource, { required: true, derived: names.split });
    put("USPPI (exporter)", "AD0_12", "Contact phone", toAesPhone(usppi.telephone, "US"), usppiSource, { required: true });
  }

  const ucSource = "Consignee";
  const pick = (record: string, text: string | undefined) =>
    record ? { value: record, source: ucSource, derived: false }
      : text ? { value: text, source: ZC_SOURCE, derived: true }
      : { value: "", source: ucSource, derived: false };
  const ucName = pick(toAesText(ultimate?.name), toAesText(zc?.name));
  put("Ultimate consignee", "AD1_3", "Name", ucName.value, ucName.source, { required: true, derived: ucName.derived });
  if (ultimate || zc) {
    const ucCountry = ultimateCountry || cod;
    const contactName = ultimate ? toAesPersonName([ultimate.contact, ultimate.contactLastName].filter(Boolean).join(" ")) : "";
    const state = ultimate ? partyStateCode(ultimate, ucCountry) : { value: "" };
    const phone = pick(ultimate ? toAesPhone(ultimate.telephone, ucCountry) : "", toAesPhone(zc?.phone, ucCountry));
    const addr1 = pick(ultimate ? line1(ultimate) : "", toAesText(zc?.line1));
    const addr2 = pick(ultimate ? line2(ultimate) : "", toAesText(zc?.line2));
    const city = pick(toAesText(ultimate?.city), toAesText(zc?.city));
    const postal = pick(ultimate ? toAesPostalCode(ultimate.zipCode, ucCountry) : "", toAesPostalCode(zc?.postal, ucCountry));
    put("Ultimate consignee", "AD1_5", "Contact name", contactName, ucSource);
    put("Ultimate consignee", "AD1_7", "Contact phone", phone.value, phone.source, { derived: phone.derived });
    put("Ultimate consignee", "AD1_8", "Address line 1", addr1.value, addr1.source, { required: true, derived: addr1.derived });
    put("Ultimate consignee", "AD1_9", "Address line 2", addr2.value, addr2.source, { derived: addr2.derived });
    put("Ultimate consignee", "AD1_10", "City", city.value, city.source, { required: true, derived: city.derived });
    put("Ultimate consignee", "AD1_11", "State / province", state.value, ucSource, { note: state.note });
    put("Ultimate consignee", "AD1_12", "Country", ucCountry,
      recordCountry ? ucSource : textCountry ? ZC_SOURCE : "Destination country (consignee has none)", {
        required: true,
        derived: !recordCountry && !!textCountry,
        note: toAesText(ultimate?.country) && !recordCountry ? `"${toAesText(ultimate?.country)}" isn't a recognizable country` : undefined,
      });
    put("Ultimate consignee", "AD1_13", "Postal code", postal.value, postal.source, { derived: postal.derived });
  }
  put("Ultimate consignee", "AD1_14", "Consignee type", "O", "Default (O = Other/Unknown)", {
    required: true,
    derived: true,
    note: "Change in AESDirect if Direct consumer (D), Government (G) or Reseller (R)",
  });
  put("Ultimate consignee", "AD1_6", "Sold en route", "N", "Default (No)", { note: "Y only if the goods are sold while in transit" });

  const fwd = input.forwarder;
  const fwdSource = !fwd ? "Sky2C details not set up in TMS" : fwd.clientId ? `Sky2C client record (${fwd.clientId})` : "Sky2C (built in)";
  put("Forwarding agent (Sky2C)", "AD3_2", "ID type", input.filerId ? "E" : "", "TMS settings (Sky2C filer ID)");
  put("Forwarding agent (Sky2C)", "AD3_4", "ID (filer EIN)", input.filerId, "TMS settings (Sky2C filer ID)");
  put("Forwarding agent (Sky2C)", "AD3_3", "Name", toAesText(fwd?.name), fwdSource);
  if (fwd) {
    const fwdCountry = toCountryCode(fwd.country) || "US";
    const contactName = toAesPersonName([fwd.contact, fwd.contactLastName].filter(Boolean).join(" "));
    put("Forwarding agent (Sky2C)", "AD3_5", "Contact name", contactName, fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_7", "Contact phone", toAesPhone(fwd.telephone, fwdCountry), fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_8", "Address line 1", line1(fwd), fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_9", "Address line 2", line2(fwd), fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_10", "City", toAesText(fwd.city), fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_11", "State", partyStateCode(fwd, fwdCountry).value, fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_12", "Country", fwdCountry, fwdSource);
    put("Forwarding agent (Sky2C)", "AD3_13", "Postal code", toAesPostalCode(fwd.zipCode, fwdCountry), fwdSource);
  }

  const items = input.containers.flatMap((c) => c.items).filter((i) =>
    toAesText(i.description) || i.declaredValueCents || i.grossWeightKgs || i.grossWeightLbs || i.isVehicle
  );
  let lineCount = 0;
  let totalValueDollars = 0;
  const lineSource: Array<{ item: AesCargoItem | null; source: string }> =
    items.length > 0
      ? items.slice(0, MAX_LINES).map((item, i) => ({ item, source: `Cargo item ${i + 1}` }))
      : toAesText(s.cargoDescription)
        ? [{ item: null, source: "Shipment cargo description (no cargo items on file)" }]
        : [];

  if (items.length > MAX_LINES) {
    rows.push({ group: "Commodity lines", code: "—", label: "Line limit", value: String(items.length), source: "Cargo", status: "warning", required: false, note: `AES allows ${MAX_LINES} lines; only the first ${MAX_LINES} are sent` });
  }

  lineSource.forEach(({ item, source }, index) => {
    const x = index + 1;
    const group = `Line ${x}`;
    lineCount = x;
    fields[`isLine${x}`] = "Y";

    const itemDescription = item ? toAesText(item.description) : "";
    const rawDescription = itemDescription || toAesText(s.cargoDescription) ||
      (item?.isVehicle ? [toAesText(item.vehicleMake), toAesText(item.vehicleModel)].filter(Boolean).join(" ") : "");
    const descriptionSource = itemDescription ? source : toAesText(s.cargoDescription) ? "Commodity Detail" : source;
    const description = rawDescription.length > MAX_DESCRIPTION
      ? rawDescription.slice(0, MAX_DESCRIPTION).replace(/[\s,;:.\-/]+$/, "")
      : rawDescription;
    put(group, `IT${x}_12`, "Commodity description", description.toUpperCase(), descriptionSource, {
      required: true,
      warning: rawDescription.length > MAX_DESCRIPTION,
      note: rawDescription.length > MAX_DESCRIPTION ? `Truncated to ${MAX_DESCRIPTION} characters` : undefined,
    });

    const valueDollars = item?.declaredValueCents ? Math.round(item.declaredValueCents / 100) : 0;
    totalValueDollars += valueDollars;
    put(group, `IT${x}_2`, "Value of goods (USD, whole dollars)", valueDollars > 0 ? String(valueDollars) : "", item ? `${source} declared value` : "Declared value (Cargo page)", {
      required: true,
      note: valueDollars > 0 ? undefined : "Fill in AESDirect (or add the declared value on the Cargo page)",
    });

    const itemKg = item?.grossWeightKgs ?? (item?.grossWeightLbs ? item.grossWeightLbs * LBS_TO_KG : null);
    const shipmentKg = lineSource.length === 1 && s.grossWeightLbs && s.grossWeightLbs > 0 ? s.grossWeightLbs * LBS_TO_KG : null;
    const kg = itemKg && itemKg > 0 ? itemKg : shipmentKg;
    const kgRounded = kg && kg > 0 ? Math.max(1, Math.round(kg)) : 0;
    const weightSource = itemKg && itemKg > 0 ? (item?.grossWeightKgs ? `${source} gross kg` : `${source} gross lbs, converted to kg`)
      : shipmentKg ? "Shipment Gross Weight (lbs, converted to kg)" : `${source} gross weight`;
    put(group, `IT${x}_7`, "Shipping weight (kg)", kgRounded > 0 ? String(kgRounded) : "", weightSource, {
      required: true,
      note: kgRounded > 0 ? undefined : "Fill in AESDirect (or add the Gross Weight / cargo weight in TMS)",
    });

    put(group, `IT${x}_1`, "Export information code", "OS", "Default (OS = all other exports)", {
      required: true,
      derived: true,
      note: "Change to HH in AESDirect only for household goods of a person moving abroad",
    });
    put(group, `IT${x}_13`, "Schedule B / HTS (10 digits)", "", "—", {
      required: true,
      notInTms: true,
      note: "Fill in AESDirect (TMS doesn't store Schedule B / HTS codes)",
    });
    put(group, `IT${x}_21`, "Origin (Domestic/Foreign)", "D", "Default (D = domestic)", {
      required: true,
      derived: true,
      note: "D = made or changed in the US; F = foreign goods exported as they came in",
    });
    const pieces = item ? item.numberOfPieces ?? 0 : lineSource.length === 1 ? palletPieces(s.palletsDimensions) : 0;
    put(group, `IT${x}_4`, "First quantity", pieces > 0 ? String(pieces) : "",
      item ? `${source} pieces${toAesText(item.pieceType) ? ` (${toAesText(item.pieceType)})` : ""}` : "Pallets x Dimensions (piece count)", {
        derived: true,
        note: pieces > 0 ? "Number of pieces: change it in AESDirect if the Schedule B unit isn't a count (e.g. kg)" : "Fill in AESDirect",
      });
    put(group, `IT${x}_8`, "License type", "C33", "Default (C33 = no license required)", {
      required: true,
      derived: true,
      note: "Change in AESDirect if a license or license exception applies",
    });

    if (item?.isVehicle) {
      fields[`IT${x}_15`] = "Y";
      rows.push({ group, code: `IT${x}_15`, label: "Used vehicle", value: "Y", source, status: "mapped", required: false });
      put(group, `IT${x}_17`, "VIN / product ID", "", "—", { required: true, notInTms: true, note: "Fill in AESDirect (TMS doesn't store VINs)" });
      put(group, `IT${x}_18`, "Vehicle title number", toAesText(item.vehicleTitle), source);
      put(group, `IT${x}_19`, "Vehicle title state", toUsStateCode(item.vehicleState), source);
    }

    put(group, `EP${x}_1`, "EPA data required (Y/N)", "N", "Default (No)");
    put(group, `AMS${x}_1`, "USDA AMS data required (Y/N)", "N", "Default (No)");
  });

  if (lineCount === 0) {
    rows.push({ group: "Commodity lines", code: "isLine1", label: "Commodity lines", value: "", source: "Cargo", status: "missing", required: true, note: "No cargo items or cargo description — add lines in AESDirect" });
  }
  if (lineCount > 0 && totalValueDollars > 0 && totalValueDollars <= LOW_VALUE_THRESHOLD_USD) {
    advisories.push(`Total value is $${totalValueDollars.toLocaleString("en-US")}. Shipments of $2,500 or less per product with no license usually don't need an AES filing. Check before filing.`);
  }

  input.containers
    .filter((c) => toAesText(c.containerNumber))
    .forEach((c, i) => {
      put("Equipment", `EQ${i + 1}`, `Container ${i + 1}`, toAesText(c.containerNumber).toUpperCase(), "Cargo container");
      put("Equipment", `SN${i + 1}`, `Seal ${i + 1}`, toAesText(c.seal1).toUpperCase(), "Cargo container seal 1");
    });

  const counts: Record<MappingStatus, number> = { mapped: 0, derived: 0, missing: 0, "not-in-tms": 0, warning: 0 };
  for (const r of rows) if (r.required || r.status !== "missing") counts[r.status] += 1;

  return { srn, fields, rows, advisories, lineCount, counts };
}
