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
import { EMPTY_AES_LINE, type AesDetails, type AesLineDetails } from "@/lib/aes/aesDetails";

// Maps a TMS shipment to AESDirect fields. Pure: no DB, no env.
// Never send made-up values; blanks are filled in AESDirect.

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
}

export interface AesCargoItem {
  // Used to find this line's AES details.
  id?: string;
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
  carrierPicklist: string | null;
  // Zoho cf_awb, used if there is no BOL/PRO.
  zohoAwb?: string | null;
}

export interface AesMappingInput {
  shipment: AesShipmentInput;
  // Exporter: shipper, else account.
  shipper: AesParty | null;
  account: AesParty | null;
  // Consignee, else ship-to.
  consignee: AesParty | null;
  shipTo: AesParty | null;
  carrier: AesParty | null;
  // Sky2C as filing agent.
  forwarder: AesParty | null;
  // "" if not set.
  filerId: string;
  containers: AesContainer[];
  // Port codes from Location.code, if any.
  portOfExportCode: string;
  portOfUnladingCode: string;
  responseEmail: string;
  successUrl: string;
  failureUrl: string;
  today: Date;
  // Saved AES details. None = same output as before.
  details?: AesDetails | null;
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
  // SRN sent (file number, dash -> C).
  srn: string;
  fields: Record<string, string>;
  rows: MappingRow[];
  // Notes for the user (possible exemptions etc).
  advisories: string[];
  lineCount: number;
  counts: Record<MappingStatus, number>;
  // Goods lines, in order, with their details key.
  lines: Array<{ key: string; description: string; vehicle: boolean }>;
}

// Max description length.
const MAX_DESCRIPTION = 45;
// Max SRN length.
const MAX_SRN = 17;
const MAX_LINES = 99;
const LBS_TO_KG = 0.45359237;
// Under $2,500 per Schedule B and no licence: filing may not be needed.
const LOW_VALUE_THRESHOLD_USD = 2500;

function line1(p: AesParty): string {
  // Use street; addressLine1 only if street is empty.
  return toAesText(p.street) || toAesText(p.addressLine1);
}

function line2(p: AesParty): string {
  return toAesText(p.street) ? toAesText(p.addressLine2) || toAesText(p.addressLine1) : toAesText(p.addressLine2);
}

// 2-letter state, only for US/CA/MX.
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

// Guess mode of transport; user confirms it.
export function deriveModeOfTransport(s: AesShipmentInput, hasContainers: boolean): { code: string; reason: string } {
  const layout = (s.zohoLayoutName ?? "").toLowerCase();
  if (s.domesticType === "DOMESTIC_AIR" || layout.includes("air")) {
    return { code: "40", reason: s.domesticType === "DOMESTIC_AIR" ? "domestic type = Domestic Air" : `layout "${s.zohoLayoutName}"` };
  }
  if (layout.includes("port") || (s.serviceType ?? "").toLowerCase().includes("port")) {
    return { code: hasContainers ? "11" : "10", reason: `${s.zohoLayoutName ? `layout "${s.zohoLayoutName}"` : `service type "${s.serviceType}"`}: ocean export${hasContainers ? ", containers on file" : ""}` };
  }
  if (s.domesticType === "RAIL" || s.domesticType === "MOTOR_RAIL") {
    return { code: hasContainers ? "21" : "20", reason: "domestic type = Rail" };
  }
  if (s.domesticType === "TRUCK" || s.domesticType === "TRUCK_TEAM") {
    return { code: hasContainers ? "31" : "30", reason: "domestic type = Truck" };
  }
  return { code: "", reason: "" };
}

export function buildWeblinkFields(input: AesMappingInput): AesMappingResult {
  const fields: Record<string, string> = {};
  const rows: MappingRow[] = [];
  const advisories: string[] = [];
  const { shipment: s } = input;
  const d = input.details ?? null;
  const DETAILS = "AES details (this page)";
  // AES details value, or "".
  const dv = (v: string | undefined | null) => toAesText(v ?? "");

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

  // ---- System ----
  put("System", "wl_success_url", "Success return URL", input.successUrl, "TMS");
  put("System", "wl_nosed_url", "Failure return URL", input.failureUrl, "TMS");
  put("System", "EMAIL", "Response email", input.responseEmail, "Your email (+ the company notification email, if set)");

  // ---- Shipment ----
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
  if (dv(d?.filingOption)) {
    put("Shipment", "FO", "Filing option", dv(d?.filingOption), DETAILS, {
      required: true,
      note: dv(d?.filingOption) === "4" ? "4 = Postdeparture (needs CBP approval)" : "2 = Predeparture",
    });
  } else {
    put("Shipment", "FO", "Filing option", "2", "Default", {
      required: true,
      derived: true,
      note: "2 = Predeparture (the AESDirect default). Option 4 (postdeparture) needs CBP approval",
    });
  }

  const bnFromDetails = dv(d?.transportRef);
  const bn = bnFromDetails || toAesText(s.bolNumber) || toAesText(s.proNumber) || toAesText(s.zohoAwb);
  put("Shipment", "BN", "Transportation reference (booking/BOL)", bn,
    bnFromDetails ? DETAILS : s.bolNumber ? "BOL Number" : s.proNumber ? "PRO Number" : toAesText(s.zohoAwb) ? "AWB (booking)" : "BOL Number");

  const usppi = input.shipper ?? input.account;
  const usppiCountry = usppi ? toCountryCode(usppi.country) || "US" : "US";
  const originState = usppi ? toUsStateCode(usppi.state) : "";
  put("Shipment", "ST", "U.S. state of origin", originState, usppi ? `Exporter state ("${toAesText(usppi.state)}")` : "Exporter state", {
    required: true,
    note: usppi && toAesText(usppi.state) && !originState ? "Not a recognizable US state" : undefined,
  });

  const poe = dv(d?.portOfExport) || input.portOfExportCode;
  put("Shipment", "POE", "Port of export (Schedule D)", poe, dv(d?.portOfExport) ? DETAILS : "Location code of Place of Receipt / Origin", {
    required: true,
    note: poe ? undefined : "TMS locations have no Schedule D port codes yet — pick the port in AESDirect",
  });

  const ultimate = input.consignee ?? input.shipTo;
  const ultimateCountry = toCountryCode(ultimate?.country);
  const cod = ultimateCountry || toCountryCode(s.country);
  put("Shipment", "COD", "Country of ultimate destination", cod, ultimate?.country ? `Consignee country ("${toAesText(ultimate.country)}")` : `Shipment country ("${toAesText(s.country)}")`, {
    required: true,
    warning: cod === "US",
    note: cod === "US" ? "Destination is the US — AES applies to exports only" : undefined,
  });
  if (cod === "US") advisories.push("The destination is the US. AES filings are only for exports. Check the consignee or shipment country.");
  if (cod === "CA") advisories.push("Destination is Canada. Most exports to Canada don't need an AES filing unless a license is needed. Check before filing.");

  const pou = dv(d?.portOfUnlading) || input.portOfUnladingCode;
  put("Shipment", "POU", "Port of unlading", pou, dv(d?.portOfUnlading) ? DETAILS : "Location code of Place of Delivery / Destination", {
    note: pou ? undefined : "Required for vessel exports — pick it in AESDirect",
  });

  const exportDate = s.shipAt ?? s.pickupScheduleAt ?? s.preferredPickupAt ?? s.etaAt;
  const exportDateSource = s.shipAt ? "Ship Date" : s.pickupScheduleAt ? "Pickup Schedule" : s.preferredPickupAt ? "Preferred Pickup" : "ETA";
  const startOfToday = Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate());
  const inPast = !!exportDate && exportDate.getTime() < startOfToday;
  put("Shipment", "EDA", "Estimated date of export", formatAesDate(exportDate), exportDateSource, {
    required: true,
    warning: inPast,
    note: inPast ? "Date is in the past — predeparture filings need a current/future export date" : undefined,
  });

  const hasContainers = input.containers.some((c) => toAesText(c.containerNumber));
  const derivedMot = deriveModeOfTransport(s, hasContainers);
  const motFromDetails = dv(d?.modeOfTransport);
  const mot = motFromDetails ? { code: motFromDetails, reason: DETAILS } : derivedMot;
  put("Shipment", "MOT", "Mode of transportation", mot.code, mot.reason || "Domestic type / layout", {
    required: true,
    derived: !motFromDetails,
    note: mot.code ? `${MOT_LABELS[mot.code]}${motFromDetails ? "" : " — derived, please confirm"}` : undefined,
  });

  const carrierCode = dv(d?.carrierCode);
  put("Shipment", "SCAC", mot.code.startsWith("4") ? "Carrier IATA code" : "Carrier SCAC code", carrierCode, carrierCode ? DETAILS : "Carrier", {
    required: true,
    notInTms: true,
    note: carrierCode ? undefined : "TMS doesn't store SCAC/IATA codes yet",
  });
  const vnFromDetails = dv(d?.conveyanceName);
  put("Shipment", "VN", "Conveyance / carrier name", vnFromDetails || toAesText(input.carrier?.name) || toAesText(s.carrierPicklist),
    vnFromDetails ? DETAILS : input.carrier ? "Carrier client" : "Carrier-Name picklist", { required: true });

  for (const [code, label, key] of [
    ["RCC", "Related company indicator", "relatedParties"],
    ["HAZ", "Hazardous material indicator", "hazardous"],
    ["RT", "Routed export transaction", "routedExport"],
  ] as const) {
    const v = dv(d?.[key]);
    put("Shipment", code, label, v, v ? DETAILS : "—", { required: true, notInTms: true });
  }

  // Optional, only if entered. IBT = in-bond code, IBN = entry number (as the old app).
  put("Shipment", "IBT", "In-bond code", dv(d?.inbondCode), DETAILS);
  put("Shipment", "IBN", "In-bond / entry number", dv(d?.entryNumber), DETAILS);
  put("Shipment", "FTZ", "Foreign trade zone number", dv(d?.ftzNumber), DETAILS);
  put("Shipment", "ORIG_ITN", "Original ITN", dv(d?.originalItn), DETAILS);

  // ---- Exporter (AD0), must be a US party ----
  const usppiSource = input.shipper ? "Shipper" : input.account ? "Account (no shipper on file)" : "Shipper";
  put("USPPI (exporter)", "AD0_1", "Name", toAesText(usppi?.name), usppiSource, { required: true });
  const exporterId = dv(d?.exporterIdNumber);
  const exporterIdType = dv(d?.exporterIdType);
  put("USPPI (exporter)", "AD0_2", "ID (EIN)", exporterId, exporterId ? DETAILS : usppiSource, { required: true, notInTms: true, note: exporterId ? undefined : "TMS doesn't store EINs yet" });
  put("USPPI (exporter)", "AD0_3", "ID type", exporterIdType, exporterIdType ? DETAILS : usppiSource, { required: true, notInTms: true, note: "EIN / DUNS / Foreign entity ID" });
  if (usppi) {
    if (usppiCountry !== "US") {
      advisories.push(`The exporter (${toAesText(usppi.name)}) has a non-US address. The exporter must be a US company. Check the shipper.`);
    }
    put("USPPI (exporter)", "AD0_4", "Address line 1", line1(usppi), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_5", "Address line 2", line2(usppi), usppiSource);
    put("USPPI (exporter)", "AD0_6", "City", toAesText(usppi.city), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_7", "State", originState, usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_8", "Postal code", toAesPostalCode(usppi.zipCode, "US"), usppiSource, {
      required: true,
      note: toAesText(usppi.zipCode) && !toAesPostalCode(usppi.zipCode, "US") ? `"${toAesText(usppi.zipCode)}" isn't a 5/9-digit US ZIP` : undefined,
    });
    put("USPPI (exporter)", "AD0_9", "Contact first name", toAesPersonName(usppi.contact), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_11", "Contact last name", toAesPersonName(usppi.contactLastName), usppiSource, { required: true });
    put("USPPI (exporter)", "AD0_12", "Contact phone", toAesPhone(usppi.telephone, "US"), usppiSource, { required: true });
  }

  // ---- Consignee (AD1) ----
  const ucSource = input.consignee ? "Consignee" : input.shipTo ? "Ship To (no consignee on file)" : "Consignee";
  put("Ultimate consignee", "AD1_3", "Name", toAesText(ultimate?.name), ucSource, { required: true });
  if (ultimate) {
    const contactName = toAesPersonName([ultimate.contact, ultimate.contactLastName].filter(Boolean).join(" "));
    const state = partyStateCode(ultimate, ultimateCountry);
    put("Ultimate consignee", "AD1_5", "Contact name", contactName, ucSource);
    put("Ultimate consignee", "AD1_7", "Contact phone", toAesPhone(ultimate.telephone, ultimateCountry), ucSource);
    put("Ultimate consignee", "AD1_8", "Address line 1", line1(ultimate), ucSource, { required: true });
    put("Ultimate consignee", "AD1_9", "Address line 2", line2(ultimate), ucSource);
    put("Ultimate consignee", "AD1_10", "City", toAesText(ultimate.city), ucSource, { required: true });
    put("Ultimate consignee", "AD1_11", "State / province", state.value, ucSource, { note: state.note });
    put("Ultimate consignee", "AD1_12", "Country", ultimateCountry, ucSource, {
      required: true,
      note: toAesText(ultimate.country) && !ultimateCountry ? `"${toAesText(ultimate.country)}" isn't a recognizable country` : undefined,
    });
    put("Ultimate consignee", "AD1_13", "Postal code", toAesPostalCode(ultimate.zipCode, ultimateCountry), ucSource);
  }
  put("Ultimate consignee", "AD1_14", "Consignee type", dv(d?.consigneeType), dv(d?.consigneeType) ? DETAILS : "—", { required: true, notInTms: true, note: "Direct consumer / Government entity / Reseller / Other-unknown" });
  put("Ultimate consignee", "AD1_6", "Sold en route", dv(d?.soldEnRoute), dv(d?.soldEnRoute) ? DETAILS : "—", { notInTms: true, note: "Y only if the goods are sold while in transit" });

  // ---- Sky2C as filing agent (AD3) ----
  const fwd = input.forwarder;
  const fwdSource = fwd ? `Sky2C client record (${fwd.clientId})` : "Sky2C details not set up in TMS";
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

  // ---- Intermediate consignee (AD4), optional ----
  {
    const imCountry = toCountryCode(d?.intermediateCountry ?? "");
    const imState = (() => {
      const raw = dv(d?.intermediateState);
      if (!raw) return "";
      if (imCountry === "US" || !imCountry) return toUsStateCode(raw);
      return (imCountry === "CA" || imCountry === "MX") && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : "";
    })();
    const g = "Intermediate consignee";
    put(g, "AD4_3", "Name", dv(d?.intermediateName), DETAILS);
    put(g, "AD4_5", "Contact name", toAesPersonName(d?.intermediateContact ?? ""), DETAILS);
    put(g, "AD4_7", "Contact phone", toAesPhone(d?.intermediatePhone ?? "", imCountry), DETAILS);
    put(g, "AD4_8", "Address line 1", dv(d?.intermediateAddress1), DETAILS);
    put(g, "AD4_9", "Address line 2", dv(d?.intermediateAddress2), DETAILS);
    put(g, "AD4_10", "City", dv(d?.intermediateCity), DETAILS);
    put(g, "AD4_11", "State / province", imState, DETAILS);
    put(g, "AD4_12", "Country", imCountry, DETAILS);
    put(g, "AD4_13", "Postal code", toAesPostalCode(d?.intermediatePostalCode ?? "", imCountry), DETAILS);
  }

  // ---- Goods lines (ITx_*) ----
  const items = input.containers.flatMap((c) => c.items).filter((i) =>
    toAesText(i.description) || i.declaredValueCents || i.grossWeightKgs || i.grossWeightLbs || i.isVehicle
  );
  let lineCount = 0;
  let totalValueDollars = 0;
  const lineSource: Array<{ item: AesCargoItem | null; source: string; key: string }> =
    items.length > 0
      ? items.slice(0, MAX_LINES).map((item, i) => ({ item, source: `Cargo item ${i + 1}`, key: item.id ?? `item${i + 1}` }))
      : toAesText(s.cargoDescription)
        ? [{ item: null, source: "Shipment cargo description (no cargo items on file)", key: "desc" }]
        : [];
  const lines: AesMappingResult["lines"] = [];

  if (items.length > MAX_LINES) {
    rows.push({ group: "Commodity lines", code: "—", label: "Line limit", value: String(items.length), source: "Cargo", status: "warning", required: false, note: `AES allows ${MAX_LINES} lines; only the first ${MAX_LINES} are sent` });
  }

  lineSource.forEach(({ item, source, key }, index) => {
    const ld: AesLineDetails = d?.lines?.[key] ?? EMPTY_AES_LINE;
    const lv = (v: string) => (d?.lines?.[key] ? toAesText(v) : "");
    const x = index + 1;
    const group = `Line ${x}`;
    lineCount = x;
    fields[`isLine${x}`] = "Y";

    const rawDescription = toAesText(item ? item.description : s.cargoDescription) ||
      (item?.isVehicle ? [toAesText(item.vehicleMake), toAesText(item.vehicleModel)].filter(Boolean).join(" ") : "");
    const description = rawDescription.length > MAX_DESCRIPTION
      ? rawDescription.slice(0, MAX_DESCRIPTION).replace(/[\s,;:.\-/]+$/, "")
      : rawDescription;
    put(group, `IT${x}_12`, "Commodity description", description.toUpperCase(), source, {
      required: true,
      warning: rawDescription.length > MAX_DESCRIPTION,
      note: rawDescription.length > MAX_DESCRIPTION ? `Truncated to ${MAX_DESCRIPTION} characters` : undefined,
    });

    const valueDollars = item?.declaredValueCents ? Math.round(item.declaredValueCents / 100) : 0;
    totalValueDollars += valueDollars;
    put(group, `IT${x}_2`, "Value of goods (USD, whole dollars)", valueDollars > 0 ? String(valueDollars) : "", `${source} declared value`, { required: true });

    const kg = item?.grossWeightKgs ?? (item?.grossWeightLbs ? item.grossWeightLbs * LBS_TO_KG : null);
    const kgRounded = kg && kg > 0 ? Math.max(1, Math.round(kg)) : 0;
    put(group, `IT${x}_7`, "Shipping weight (kg)", kgRounded > 0 ? String(kgRounded) : "", item?.grossWeightKgs ? `${source} gross kg` : `${source} gross lbs, converted to kg`, { required: true });

    lines.push({ key, description: description || toAesText(item?.description) || `Line ${x}`, vehicle: !!item?.isVehicle });
    const src = (v: string) => (v ? DETAILS : "—");
    put(group, `IT${x}_13`, "Schedule B / HTS (10 digits)", lv(ld.scheduleB), src(lv(ld.scheduleB)), { required: true, notInTms: true });
    put(group, `IT${x}_1`, "Export information code", lv(ld.exportInfoCode), src(lv(ld.exportInfoCode)), { required: true, notInTms: true, note: "Usually OS (all other exports)" });
    put(group, `IT${x}_8`, "License type", lv(ld.licenseType), src(lv(ld.licenseType)), { required: true, notInTms: true, note: "e.g. C33 = no license required (NLR)" });
    put(group, `IT${x}_21`, "Origin (Domestic/Foreign)", lv(ld.origin), src(lv(ld.origin)), { required: true, notInTms: true });
    put(group, `IT${x}_4`, "Unit + quantity (Schedule B unit)", lv(ld.quantity1), src(lv(ld.quantity1)), {
      notInTms: true,
      note: lv(ld.quantity1)
        ? undefined
        : item?.numberOfPieces ? `TMS has ${item.numberOfPieces} ${toAesText(item.pieceType) || "piece(s)"} — enter the quantity in the Schedule B unit in AESDirect` : undefined,
    });
    // Optional line items, only if entered.
    put(group, `IT${x}_3`, "Unit of measure 1", lv(ld.unit1), DETAILS);
    put(group, `IT${x}_5`, "Unit of measure 2", lv(ld.unit2), DETAILS);
    put(group, `IT${x}_6`, "Quantity 2", lv(ld.quantity2), DETAILS);
    put(group, `IT${x}_9`, "License number / exemption", lv(ld.licenseNumber), DETAILS);
    put(group, `IT${x}_10`, "License value (USD)", lv(ld.licenseValue), DETAILS);
    put(group, `IT${x}_20`, "ECCN", lv(ld.eccn), DETAILS);

    if (item?.isVehicle) {
      fields[`IT${x}_15`] = "Y";
      rows.push({ group, code: `IT${x}_15`, label: "Used vehicle", value: "Y", source, status: "mapped", required: false });
      put(group, `IT${x}_16`, "Vehicle ID type", lv(ld.vehicleIdType), DETAILS);
      put(group, `IT${x}_17`, "VIN / product ID", lv(ld.vin), src(lv(ld.vin)), { required: true, notInTms: true, note: lv(ld.vin) ? undefined : "TMS doesn't store VINs yet" });
      put(group, `IT${x}_18`, "Vehicle title number", toAesText(item.vehicleTitle), source);
      put(group, `IT${x}_19`, "Vehicle title state", toUsStateCode(item.vehicleState), source);
    }

    // ITAR items (State Department goods only).
    const ddtcGroup = `${group}`;
    put(ddtcGroup, `ODTC${x}_1`, "DDTC ITAR exemption number", lv(ld.ddtcItarExemption), DETAILS);
    put(ddtcGroup, `ODTC${x}_2`, "DDTC registration number", lv(ld.ddtcRegistration), DETAILS);
    put(ddtcGroup, `ODTC${x}_3`, "DDTC significant military equipment (Y/N)", lv(ld.ddtcSignificantMilitary), DETAILS);
    put(ddtcGroup, `ODTC${x}_4`, "DDTC eligible party certification (Y/N)", lv(ld.ddtcEligibleParty), DETAILS);
    put(ddtcGroup, `ODTC${x}_5`, "DDTC USML category", lv(ld.ddtcUsmlCategory), DETAILS);
    put(ddtcGroup, `ODTC${x}_6`, "DDTC unit of measure", lv(ld.ddtcUnit), DETAILS, { note: "Position not confirmed by CBP's mapping; the legacy app left it blank" });
    put(ddtcGroup, `ODTC${x}_7`, "DDTC quantity", lv(ld.ddtcQuantity), DETAILS);

    // EPA / USDA AMS flags.
    put(group, `EP${x}_1`, "EPA data required (Y/N)", lv(ld.epaRequired), DETAILS, { note: lv(ld.epaRequired) === "Y" ? "Complete the EPA data in AESDirect" : undefined });
    put(group, `AMS${x}_1`, "USDA AMS data required (Y/N)", lv(ld.amsRequired), DETAILS, { note: lv(ld.amsRequired) === "Y" ? "Complete the USDA AMS data in AESDirect" : undefined });
  });

  if (lineCount === 0) {
    rows.push({ group: "Commodity lines", code: "isLine1", label: "Commodity lines", value: "", source: "Cargo", status: "missing", required: true, note: "No cargo items or cargo description — add lines in AESDirect" });
  }
  if (lineCount > 0 && totalValueDollars > 0 && totalValueDollars <= LOW_VALUE_THRESHOLD_USD) {
    advisories.push(`Total value is $${totalValueDollars.toLocaleString("en-US")}. Shipments of $2,500 or less per product with no license usually don't need an AES filing. Check before filing.`);
  }

  // ---- Containers (EQx / SNx) ----
  input.containers
    .filter((c) => toAesText(c.containerNumber))
    .forEach((c, i) => {
      put("Equipment", `EQ${i + 1}`, `Container ${i + 1}`, toAesText(c.containerNumber).toUpperCase(), "Cargo container");
      put("Equipment", `SN${i + 1}`, `Seal ${i + 1}`, toAesText(c.seal1).toUpperCase(), "Cargo container seal 1");
    });

  const counts: Record<MappingStatus, number> = { mapped: 0, derived: 0, missing: 0, "not-in-tms": 0, warning: 0 };
  for (const r of rows) if (r.required || r.status !== "missing") counts[r.status] += 1;

  return { srn, fields, rows, advisories, lineCount, counts, lines };
}
