import { toCountryCode } from "@/lib/aes/codes";

// Reads a free-text name + address block (Zoho "Consignee Details"). Pure.
// Example: "Ravi Kumar\n12 MG Road\nChennai 600001\nTamil Nadu, India\nPh: +91 98400 12345".

export interface PartyText {
  name: string;
  line1: string;
  line2: string;
  city: string;
  postal: string;
  // ISO country code, or "".
  country: string;
  phone: string;
}

const PHONE_LABEL = /^(?:ph|phone|tel|telephone|mob|mobile|cell|contact(?:\s*no)?)\b\.?\s*(?:no\.?)?\s*[:#-]?\s*/i;
const PHONE_ONLY = /^\+?[\d\s().\/-]{7,}$/;

const digitCount = (v: string) => (v.match(/\d/g) ?? []).length;

export function parsePartyText(raw: string | null | undefined): PartyText | null {
  let lines = (raw ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // One line: split on commas.
  if (lines.length === 1) lines = lines[0].split(",").map((p) => p.trim()).filter(Boolean);

  const out: PartyText = { name: "", line1: "", line2: "", city: "", postal: "", country: "", phone: "" };
  const rest: string[] = [];
  for (const line of lines) {
    if (/\S+@\S+\.\S+/.test(line)) continue;
    const labelled = line.match(PHONE_LABEL);
    const phonePart = labelled ? line.slice(labelled[0].length) : line;
    if ((labelled || PHONE_ONLY.test(line)) && PHONE_ONLY.test(phonePart) && digitCount(phonePart) >= 7) {
      if (!out.phone) out.phone = phonePart.trim();
      continue;
    }
    rest.push(line);
  }
  if (rest.length === 0) return out.phone ? out : null;

  // Country at the end ("India" or "Tamil Nadu, India"); a leftover state/province line is dropped.
  const last = rest[rest.length - 1];
  const segments = last.split(",").map((p) => p.trim()).filter(Boolean);
  const tail = segments[segments.length - 1] ?? "";
  const tailCountry = digitCount(tail) === 0 ? toCountryCode(tail) : "";
  if (tailCountry && rest.length > 1) {
    out.country = tailCountry;
    const before = segments.slice(0, -1).join(", ");
    if (!before || (digitCount(before) === 0 && !before.includes(",") && rest.length > 2)) rest.pop();
    else rest[rest.length - 1] = before;
  }
  // A state line after the "City 600001" line.
  const endsWithPostal = (l: string) => /(\b\d{5,6}|\b\d{3} \d{3})$/.test(l) && !/\bbox\b/i.test(l);
  if (rest.length >= 4 && digitCount(rest[rest.length - 1]) === 0 && endsWithPostal(rest[rest.length - 2])) rest.pop();

  out.name = rest.shift() ?? "";
  // A single address line with commas: "12 MG Road, Chennai 600001".
  const address = rest.length === 1 && rest[0].includes(",") ? rest[0].split(",").map((p) => p.trim()).filter(Boolean) : rest;
  if (address.length === 0) return out;
  out.line1 = address[0];
  if (address.length === 1) return out;

  // Last line holds the city and postal code: "Chennai - 600001", "Dubai", "Hamburg 20095".
  const cityLine = address[address.length - 1];
  const postal = cityLine.match(/\b(\d{3}\s?\d{3}|\d{4,5}(?:-\d{4})?)\b(?!.*\d)/);
  if (postal) out.postal = postal[1].replace(/\s/g, "");
  const city = cityLine.replace(postal?.[0] ?? "", " ").split(",")[0].replace(/[-–\s]+$/, "").replace(/^[-–\s]+/, "").trim();
  if (city && digitCount(city) === 0) out.city = city;
  out.line2 = address.slice(1, -1).join(", ");
  return out;
}
