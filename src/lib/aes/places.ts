import { toCountryCode, toUsStateCode } from "@/lib/aes/codes";

// Reads free-text places from Zoho/TMS, e.g. "Los Angeles, CA", "Oakland (2811)", "Nhava Sheva, India".
// Pure. foreign = the place is expected abroad (destination), so "IN" means India, not Indiana.

export interface PlaceText {
  head: string;
  state: string;
  country: string;
  portCode: string;
}

export function parsePlaceText(raw: string | null | undefined, opts: { foreign?: boolean } = {}): PlaceText {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const out: PlaceText = { head: "", state: "", country: "", portCode: "" };
  if (!text) return out;

  // A CBP port code given on its own or in brackets: "2811" or "Oakland (2811)". A ZIP in an address doesn't count.
  const own = text.match(/^(\d{4,5})$/);
  const bracket = text.match(/\((\d{4,5})\)/);
  out.portCode = own?.[1] ?? bracket?.[1] ?? "";

  const parts = text.replace(/\([^)]*\)/g, "").split(",").map((p) => p.trim()).filter(Boolean);
  out.head = parts[0] ?? "";
  for (const part of parts.slice(1).reverse()) {
    const token = part.split(" ")[0];
    const asCountry = toCountryCode(part) || (opts.foreign ? toCountryCode(token) : "");
    const asState = toUsStateCode(part) || toUsStateCode(token);
    if (opts.foreign && asCountry && !out.country) out.country = asCountry;
    else if (asState && !out.state) out.state = asState;
    else if (asCountry && !out.country) out.country = asCountry;
  }
  if (out.state && !out.country) out.country = "US";
  return out;
}
