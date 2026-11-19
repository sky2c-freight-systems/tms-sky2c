/**
 * Code normalization for AES WebLink fields. AES wants bare codes (two-letter US state,
 * ISO-3166 alpha-2 country, numeric mode-of-transport), while TMS stores free text typed by
 * ops or copied from Zoho ("California", "United States", "CA"). Everything here returns ""
 * when it can't be sure, so the field is left for the user to pick in AESDirect rather than
 * pre-filled with a guess.
 */

const US_STATES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY",
  LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND",
  OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
  "PUERTO RICO": "PR", "VIRGIN ISLANDS": "VI", "U.S. VIRGIN ISLANDS": "VI", GUAM: "GU",
  "AMERICAN SAMOA": "AS", "NORTHERN MARIANA ISLANDS": "MP",
};
const US_STATE_CODES = new Set(Object.values(US_STATES));

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** "California" / "CA" / "ca" / "CA - California" → "CA"; anything unrecognized → "". */
export function toUsStateCode(value: string | null | undefined): string {
  const v = clean(value).toUpperCase();
  if (!v) return "";
  if (US_STATE_CODES.has(v)) return v;
  // Legacy-style "CA - California"
  const lead = v.match(/^([A-Z]{2})\s*-/);
  if (lead && US_STATE_CODES.has(lead[1])) return lead[1];
  return US_STATES[v.replace(/\./g, "").replace(/^STATE OF /, "")] ?? US_STATES[v] ?? "";
}

const COUNTRY_ALIASES: Record<string, string> = {
  USA: "US", "U.S.A.": "US", "U.S.": "US", "UNITED STATES OF AMERICA": "US", AMERICA: "US",
  UK: "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB", BRITAIN: "GB",
  UAE: "AE", "U.A.E.": "AE", "SOUTH KOREA": "KR", KOREA: "KR", "NORTH KOREA": "KP",
  RUSSIA: "RU", VIETNAM: "VN", "VIET NAM": "VN", "IVORY COAST": "CI", HOLLAND: "NL",
  "CZECH REPUBLIC": "CZ", TURKEY: "TR", "TURKIYE": "TR", "HONG KONG": "HK", TAIWAN: "TW",
  "DOMINICAN REP": "DO", "PEOPLES REPUBLIC OF CHINA": "CN", PRC: "CN",
};

let countryNameIndex: Map<string, string> | null = null;

/** Builds NAME → alpha-2 from the runtime's ICU data (Node ships full-icu), once. */
function getCountryNameIndex(): Map<string, string> {
  if (countryNameIndex) return countryNameIndex;
  const index = new Map<string, string>();
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i) + String.fromCharCode(A + j);
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        name = undefined;
      }
      if (name && name !== code) index.set(name.toUpperCase(), code);
    }
  }
  countryNameIndex = index;
  return index;
}

/** "India" / "IN" / "United States" / "US - United States" → alpha-2; unrecognized → "". */
export function toCountryCode(value: string | null | undefined): string {
  const v = clean(value).toUpperCase();
  if (!v) return "";
  const index = getCountryNameIndex();
  const knownCodes = new Set(index.values());
  if (/^[A-Z]{2}$/.test(v) && knownCodes.has(v)) return v;
  const lead = v.match(/^([A-Z]{2})\s*-/);
  if (lead && knownCodes.has(lead[1])) return lead[1];
  return COUNTRY_ALIASES[v] ?? index.get(v) ?? "";
}

/** Digits only — the legacy app sent phone numbers this way (e.g. 5107433300). */
export function digitsOnly(value: string | null | undefined): string {
  return clean(value).replace(/\D/g, "");
}

/**
 * AES/AESDirect text is plain ASCII. Accented letters are transliterated ("São Paulo" →
 * "Sao Paulo"), other non-printable/non-ASCII characters dropped, whitespace collapsed.
 * Applied to every value posted to WebLink so a stray "é" or curly quote from Zoho can't
 * break the filing.
 */
export function toAesText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Contact names: AESDirect requires at least two letters and rejects "special characters
 * such as accents or punctuation" (ACE AESDirect User Guide). Letters, spaces, hyphens and
 * apostrophes are kept; anything else removed. Returns "" when fewer than two letters remain.
 */
export function toAesPersonName(value: string | null | undefined): string {
  const name = toAesText(value).replace(/[^A-Za-z '-]/g, "").replace(/\s+/g, " ").trim();
  return (name.match(/[A-Za-z]/g)?.length ?? 0) >= 2 ? name : "";
}

/**
 * Phone digits. For a US party a leading country code 1 on an 11-digit number is dropped
 * ("+1 (510) 555-0100" → "5105550100"); foreign numbers keep their country code.
 */
export function toAesPhone(value: string | null | undefined, countryCode: string): string {
  const digits = digitsOnly(value);
  if (countryCode === "US" && digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** US ZIP as 5 or 9 digits ("94545-1234" → "945451234"); non-US postal codes pass through as ASCII text. */
export function toAesPostalCode(value: string | null | undefined, countryCode: string): string {
  if (countryCode !== "US") return toAesText(value);
  const digits = digitsOnly(value);
  return digits.length === 5 || digits.length === 9 ? digits : "";
}

/**
 * Shipment Reference Number: AES allows 1–17 alphanumeric characters only (ACE AESDirect
 * User Guide), so a child file number's dash can't be sent as-is. The dash becomes "C"
 * ("101060000-1" → "101060000C1"): still unique, because top-level file numbers are all
 * digits, and still readable as "child 1 of 101060000". Any other non-alphanumeric is dropped.
 * Never reuse an SRN for another shipment — corrections resend the SAME SRN with FAC=R.
 */
export function toSrn(fileNumber: string): string {
  return fileNumber.replace(/-/g, "C").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Filer ID (FID): the filer's EIN, typed with or without the dash ("12-3456789" → "123456789"). */
export function toFilerId(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s-]/g, "").toUpperCase();
}

/** ITN as AES issues it: "X" + 14 digits. */
export const ITN_PATTERN = /^X\d{14}$/;

/**
 * AES mode-of-transportation codes (Census AES "MOT" list). Only the ones TMS can
 * plausibly derive are listed; the rest stay for the user to choose in AESDirect.
 */
export const MOT_LABELS: Record<string, string> = {
  "10": "Vessel, non-containerized",
  "11": "Vessel, containerized",
  "20": "Rail, non-containerized",
  "21": "Rail, containerized",
  "30": "Truck, non-containerized",
  "31": "Truck, containerized",
  "40": "Air, non-containerized",
  "41": "Air, containerized",
};

/** Formats a Date as the MM/DD/YYYY that WebLink's EDA field expects (UTC calendar date). */
export function formatAesDate(date: Date | null | undefined): string {
  if (!date) return "";
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}
