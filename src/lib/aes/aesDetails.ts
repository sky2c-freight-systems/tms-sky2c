import { z } from "zod";

// AES details entered on the AES page (stored in ShipmentAes).
// All optional; empty = use TMS value. Shared by the form and the server.

const yn = z.enum(["", "Y", "N"]).default("");
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`).default("");
const pattern = (re: RegExp, message: string, max = 40) =>
  z.string().trim().toUpperCase().max(max).default("").refine((v) => v === "" || re.test(v), { message });
// Like pattern(), but strips dots, dashes and spaces first.
const digitsPattern = (re: RegExp, message: string, max = 40) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(/[.\-\s]/g, "") : v), pattern(re, message, max));

export const MOT_OPTIONS: Array<[string, string]> = [
  ["10", "Vessel, non-containerized"],
  ["11", "Vessel, containerized"],
  ["20", "Rail, non-containerized"],
  ["21", "Rail, containerized"],
  ["30", "Truck, non-containerized"],
  ["31", "Truck, containerized"],
  ["40", "Air, non-containerized"],
  ["41", "Air, containerized"],
];
export const PARTY_ID_TYPES: Array<[string, string]> = [["E", "EIN"], ["D", "DUNS"], ["T", "Foreign entity"]];
export const CONSIGNEE_TYPES: Array<[string, string]> = [["D", "Direct consumer"], ["G", "Government entity"], ["R", "Reseller"], ["O", "Other / unknown"]];
export const ORIGIN_TYPES: Array<[string, string]> = [["D", "Domestic (made in the US)"], ["F", "Foreign (made abroad)"]];
export const VEHICLE_ID_TYPES: Array<[string, string]> = [["V", "VIN"], ["P", "Product ID"]];

export const aesLineSchema = z.object({
  scheduleB: digitsPattern(/^\d{10}$/, "Schedule B number must be 10 digits.", 20),
  exportInfoCode: pattern(/^[A-Z0-9]{2}$/, "Export information code is 2 letters/digits (usually OS)."),
  licenseType: pattern(/^[A-Z0-9]{3}$/, "License type is 3 letters/digits (C33 = no license required)."),
  licenseNumber: pattern(/^[A-Z0-9 .\-/]{1,24}$/, "License number: letters, digits, spaces, dots, dashes only.", 24),
  licenseValue: pattern(/^\d{1,10}$/, "License value: whole US dollars.", 10),
  eccn: pattern(/^[0-9][A-Z][0-9]{3}[A-Z0-9.]*$|^EAR99$/, "ECCN looks like 5A992 or EAR99.", 12),
  origin: z.enum(["", "D", "F"]).default(""),
  quantity1: pattern(/^\d{1,10}$/, "Quantity: whole number.", 10),
  unit1: pattern(/^[A-Z0-9]{1,3}$/, "Unit is a short code (e.g. KG, NO, X).", 3),
  quantity2: pattern(/^\d{1,10}$/, "Quantity: whole number.", 10),
  unit2: pattern(/^[A-Z0-9]{1,3}$/, "Unit is a short code (e.g. KG, NO).", 3),
  vehicleIdType: z.enum(["", "V", "P"]).default(""),
  vin: pattern(/^[A-Z0-9]{1,25}$/, "VIN / product ID: letters and digits only.", 25),
  ddtcItarExemption: text(20),
  ddtcRegistration: text(20),
  ddtcSignificantMilitary: yn,
  ddtcEligibleParty: yn,
  ddtcUsmlCategory: text(10),
  ddtcUnit: text(5),
  ddtcQuantity: pattern(/^\d{1,10}$/, "Quantity: whole number.", 10),
  epaRequired: yn,
  amsRequired: yn,
});

export const aesDetailsSchema = z.object({
  filingOption: z.enum(["", "2", "4"]).default(""),
  modeOfTransport: z.enum(["", ...MOT_OPTIONS.map(([c]) => c)] as [string, ...string[]]).default(""),
  portOfExport: pattern(/^\d{4}$/, "US port of export is a 4-digit code.", 4),
  portOfUnlading: pattern(/^\d{4,5}$/, "Port of unloading is a 4- or 5-digit code.", 5),
  transportRef: pattern(/^[A-Z0-9\-]{1,30}$/, "Booking / AWB / BOL number: letters, digits and dashes.", 30),
  carrierCode: pattern(/^[A-Z0-9]{2,4}$/, "Carrier code is the 2–4 letter SCAC (or IATA code for air).", 4),
  conveyanceName: text(23),
  relatedParties: yn,
  hazardous: yn,
  routedExport: yn,
  inbondCode: pattern(/^[0-9]{2}$/, "In-bond code is 2 digits.", 2),
  entryNumber: pattern(/^[A-Z0-9]{1,15}$/, "Entry number: letters and digits only.", 15),
  ftzNumber: pattern(/^[A-Z0-9]{1,7}$/, "FTZ number: up to 7 letters/digits.", 7),
  originalItn: pattern(/^X\d{14}$/, "ITN is X followed by 14 digits.", 15),

  exporterIdNumber: digitsPattern(/^[A-Z0-9]{9,11}$/, "Exporter ID: 9 digits for EIN/DUNS.", 11),
  exporterIdType: z.enum(["", "E", "D", "T"]).default(""),

  consigneeType: z.enum(["", "D", "G", "R", "O"]).default(""),
  soldEnRoute: yn,

  intermediateName: text(30),
  intermediateContact: text(30),
  intermediatePhone: text(20),
  intermediateAddress1: text(32),
  intermediateAddress2: text(32),
  intermediateCity: text(25),
  intermediateState: text(30),
  intermediateCountry: text(30),
  intermediatePostalCode: text(10),

  // Per goods line, keyed by cargo item id ("desc" if no items).
  lines: z.record(z.string().max(40), aesLineSchema).default({}),
});

export type AesLineDetails = z.infer<typeof aesLineSchema>;
export type AesDetails = z.infer<typeof aesDetailsSchema>;

export const EMPTY_AES_DETAILS: AesDetails = aesDetailsSchema.parse({});
export const EMPTY_AES_LINE: AesLineDetails = aesLineSchema.parse({});

// Lenient read: bad values are reset, the rest kept.
export function readAesDetails(raw: unknown): AesDetails {
  const parsed = aesDetailsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const out: Record<string, unknown> = {};
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const [k, schema] of Object.entries(aesDetailsSchema.shape)) {
    if (k === "lines") continue;
    const r = (schema as z.ZodTypeAny).safeParse(src[k]);
    if (r.success) out[k] = r.data;
  }
  const lines: Record<string, AesLineDetails> = {};
  if (src.lines && typeof src.lines === "object") {
    for (const [key, line] of Object.entries(src.lines as Record<string, unknown>)) {
      const r = aesLineSchema.safeParse(line);
      lines[key] = r.success ? r.data : EMPTY_AES_LINE;
    }
  }
  return aesDetailsSchema.parse({ ...out, lines });
}

// Validates form input; errors keyed by field path.
export function validateAesDetails(input: unknown): { ok: true; details: AesDetails } | { ok: false; errors: Record<string, string> } {
  const r = aesDetailsSchema.safeParse(input);
  if (r.success) return { ok: true, details: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".");
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}
