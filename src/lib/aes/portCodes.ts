import { toCountryCode, toUsStateCode } from "@/lib/aes/codes";

type Mode = "air" | "sea" | "land";

interface PortEntry {
  code: string;
  name: string;
  state: string;
  keys: string[];
  codes?: string[];
  modes?: Mode[];
  needsState?: boolean;
  airport?: boolean;
}

const PORTS: PortEntry[] = [
  { code: "2811", name: "Oakland, CA", state: "CA", keys: ["OAKLAND"], codes: ["OAK", "USOAK"] },
  { code: "2801", name: "San Francisco Intl Airport, CA", state: "CA", keys: ["SAN FRANCISCO INTL", "SAN FRANCISCO AIRPORT"], codes: ["SFO"], airport: true },
  { code: "2801", name: "San Francisco Intl Airport, CA", state: "CA", keys: ["SAN FRANCISCO"], codes: ["USSFO"], modes: ["air"], airport: true },
  { code: "2809", name: "San Francisco, CA", state: "CA", keys: ["SAN FRANCISCO"], codes: ["USSFO"], modes: ["sea", "land"] },
  { code: "2720", name: "Los Angeles Intl Airport, CA", state: "CA", keys: ["LOS ANGELES INTL", "LOS ANGELES AIRPORT"], codes: ["LAX"], airport: true },
  { code: "2720", name: "Los Angeles Intl Airport, CA", state: "CA", keys: ["LOS ANGELES"], codes: ["USLAX"], modes: ["air"], airport: true },
  { code: "2704", name: "Los Angeles, CA", state: "CA", keys: ["LOS ANGELES", "SAN PEDRO"], codes: ["USLAX"], modes: ["sea", "land"] },
  { code: "2709", name: "Long Beach, CA", state: "CA", keys: ["LONG BEACH"], codes: ["USLGB"] },
  { code: "2501", name: "San Diego, CA", state: "CA", keys: ["SAN DIEGO"], codes: ["USSAN"] },
  { code: "3029", name: "Seattle-Tacoma Intl Airport, WA", state: "WA", keys: ["SEATTLE TACOMA", "SEATAC", "SEA TAC", "SEATTLE INTL", "SEATTLE AIRPORT"], codes: ["SEA"], airport: true },
  { code: "3029", name: "Seattle-Tacoma Intl Airport, WA", state: "WA", keys: ["SEATTLE"], codes: ["USSEA"], modes: ["air"], airport: true },
  { code: "3001", name: "Seattle, WA", state: "WA", keys: ["SEATTLE"], codes: ["USSEA"], modes: ["sea", "land"] },
  { code: "3002", name: "Tacoma, WA", state: "WA", keys: ["TACOMA"], codes: ["USTIW"], modes: ["sea", "land"] },
  { code: "2904", name: "Portland, OR", state: "OR", keys: ["PORTLAND"], codes: ["PDX", "USPDX"], needsState: true },
  { code: "3126", name: "Anchorage, AK", state: "AK", keys: ["ANCHORAGE"], codes: ["ANC", "USANC"] },
  { code: "3201", name: "Honolulu, HI", state: "HI", keys: ["HONOLULU"], codes: ["HNL", "USHNL"] },
  { code: "4701", name: "John F. Kennedy Airport, NY", state: "NY", keys: ["KENNEDY", "JFK"], codes: ["JFK"], airport: true },
  { code: "4701", name: "John F. Kennedy Airport, NY", state: "NY", keys: ["NEW YORK"], codes: ["USNYC"], modes: ["air"], airport: true },
  { code: "4601", name: "New York/Newark Area, NJ", state: "NJ", keys: ["NEWARK", "ELIZABETH"], codes: ["EWR", "USEWR"], needsState: true },
  { code: "0401", name: "Boston, MA", state: "MA", keys: ["BOSTON"], codes: ["BOS", "USBOS"] },
  { code: "1101", name: "Philadelphia, PA", state: "PA", keys: ["PHILADELPHIA"], codes: ["PHL", "USPHL"] },
  { code: "1303", name: "Baltimore, MD", state: "MD", keys: ["BALTIMORE"], codes: ["USBAL"] },
  { code: "1401", name: "Norfolk-Newport News, VA", state: "VA", keys: ["NORFOLK", "NEWPORT NEWS"], codes: ["USORF"] },
  { code: "1601", name: "Charleston, SC", state: "SC", keys: ["CHARLESTON"], codes: ["USCHS"], needsState: true },
  { code: "1703", name: "Savannah, GA", state: "GA", keys: ["SAVANNAH"], codes: ["USSAV"] },
  { code: "1803", name: "Jacksonville, FL", state: "FL", keys: ["JACKSONVILLE"], codes: ["USJAX"], needsState: true },
  { code: "1801", name: "Tampa, FL", state: "FL", keys: ["TAMPA"], codes: ["USTPA"] },
  { code: "5203", name: "Port Everglades, FL", state: "FL", keys: ["PORT EVERGLADES"], codes: ["USPEF"] },
  { code: "5206", name: "Miami Intl Airport, FL", state: "FL", keys: ["MIAMI INTL", "MIAMI AIRPORT"], codes: ["MIA"], airport: true },
  { code: "5206", name: "Miami Intl Airport, FL", state: "FL", keys: ["MIAMI"], codes: ["USMIA"], modes: ["air"], airport: true },
  { code: "5201", name: "Miami, FL", state: "FL", keys: ["MIAMI"], codes: ["USMIA"], modes: ["sea", "land"] },
  { code: "1901", name: "Mobile, AL", state: "AL", keys: ["MOBILE"], codes: ["USMOB"], needsState: true },
  { code: "2002", name: "New Orleans, LA", state: "LA", keys: ["NEW ORLEANS"], codes: ["USMSY"] },
  { code: "5309", name: "Houston Intercontinental Airport, TX", state: "TX", keys: ["HOUSTON INTERCONTINENTAL", "HOUSTON INTL", "GEORGE BUSH", "HOUSTON AIRPORT"], codes: ["IAH"], airport: true },
  { code: "5309", name: "Houston Intercontinental Airport, TX", state: "TX", keys: ["HOUSTON"], codes: ["USHOU"], modes: ["air"], airport: true },
  { code: "5301", name: "Houston, TX", state: "TX", keys: ["HOUSTON"], codes: ["USHOU"], modes: ["sea", "land"] },
  { code: "5501", name: "Dallas/Fort Worth Airport, TX", state: "TX", keys: ["DALLAS", "FORT WORTH", "FT WORTH"], codes: ["DFW", "USDFW"], modes: ["air"], airport: true },
  { code: "2304", name: "Laredo, TX", state: "TX", keys: ["LAREDO"], codes: ["USLRD"] },
  { code: "2402", name: "El Paso, TX", state: "TX", keys: ["EL PASO"], codes: ["USELP"] },
  { code: "3901", name: "Chicago, IL (incl. O'Hare)", state: "IL", keys: ["CHICAGO", "O HARE", "OHARE"], codes: ["ORD", "USCHI"] },
  { code: "3801", name: "Detroit, MI", state: "MI", keys: ["DETROIT"], modes: ["sea", "land"] },
  { code: "2006", name: "Memphis, TN", state: "TN", keys: ["MEMPHIS"], codes: ["MEM", "USMEM"] },
  { code: "4115", name: "Louisville, KY", state: "KY", keys: ["LOUISVILLE"], codes: ["SDF"] },
  { code: "4102", name: "Cincinnati, OH", state: "OH", keys: ["CINCINNATI"] },
  { code: "4110", name: "Indianapolis, IN", state: "IN", keys: ["INDIANAPOLIS"], codes: ["IND"] },
  { code: "3307", name: "Denver, CO", state: "CO", keys: ["DENVER"], codes: ["DEN"] },
  { code: "3303", name: "Salt Lake City, UT", state: "UT", keys: ["SALT LAKE CITY"], codes: ["SLC"] },
  { code: "3501", name: "Minneapolis-St. Paul, MN", state: "MN", keys: ["MINNEAPOLIS"], codes: ["MSP"] },
  { code: "2605", name: "Phoenix, AZ", state: "AZ", keys: ["PHOENIX"], codes: ["PHX"] },
];

export interface PortMatch {
  code: string;
  name: string;
  airport: boolean;
}

interface Place {
  name?: string | null;
  code?: string | null;
  state?: string | null;
  country?: string | null;
}

const FOREIGN_PORTS: PortEntry[] = [
  { code: "42305", name: "Antwerp, Belgium", state: "BE", keys: ["ANTWERP", "ANTWERPEN", "ANVERS"], codes: ["BEANR"] },
  { code: "42879", name: "Hamburg, Germany", state: "DE", keys: ["HAMBURG"], codes: ["DEHAM"] },
  { code: "42737", name: "Le Havre, France", state: "FR", keys: ["LE HAVRE"], codes: ["FRLEH"] },
  { code: "57035", name: "Shanghai, China", state: "CN", keys: ["SHANGHAI"], codes: ["CNSHA"] },
  { code: "57020", name: "Ningbo, China", state: "CN", keys: ["NINGBO", "NINGPO"], codes: ["CNNGB"] },
  { code: "57078", name: "Yantian, China", state: "CN", keys: ["YANTIAN"], codes: ["CNYTN"] },
  { code: "58309", name: "Kaohsiung, Taiwan", state: "TW", keys: ["KAOHSIUNG", "KAO HSIUNG"], codes: ["TWKHH"] },
  { code: "53827", name: "Chittagong, Bangladesh", state: "BD", keys: ["CHITTAGONG", "CHATTOGRAM"], codes: ["BDCGP"] },
  { code: "60267", name: "Sydney, Australia", state: "AU", keys: ["SYDNEY"], codes: ["AUSYD"], needsState: true },
  { code: "60237", name: "Melbourne, Australia", state: "AU", keys: ["MELBOURNE"], codes: ["AUMEL"], needsState: true },
  { code: "35177", name: "Santos, Brazil", state: "BR", keys: ["SANTOS"], codes: ["BRSSZ"] },
  { code: "30107", name: "Cartagena, Colombia", state: "CO", keys: ["CARTAGENA"], codes: ["COCTG"], needsState: true },
  { code: "12493", name: "Vancouver, BC", state: "CA", keys: ["VANCOUVER"], codes: ["CAVAN"], needsState: true },
  { code: "74990", name: "Tema, Ghana", state: "GH", keys: ["TEMA"], codes: ["GHTEM"] },
];

function modeOf(motCode: string): Mode | "" {
  if (motCode.startsWith("4")) return "air";
  if (motCode.startsWith("1")) return "sea";
  if (/^[23]/.test(motCode)) return "land";
  return "";
}

function words(v: string): string {
  return ` ${v.toUpperCase().replace(/\bINT'?L\b|\bINTERNATIONAL\b/g, "INTL").replace(/[^A-Z0-9]+/g, " ").trim()} `;
}

function match(list: PortEntry[], place: Place, region: string, mode: Mode | ""): PortMatch | null {
  const fits = (p: PortEntry) =>
    (!p.modes || (mode !== "" && p.modes.includes(mode))) && (region ? region === p.state : !p.needsState);
  const pick = (hits: PortEntry[]) =>
    hits.length > 0 && hits.every((p) => p.code === hits[0].code) ? { code: hits[0].code, name: hits[0].name, airport: !!hits[0].airport } : null;

  const name = (place.name ?? "").trim();
  const codes = [place.code ?? "", name, name.match(/\(([A-Za-z]{3,5})\)/)?.[1] ?? ""]
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const byCode = list.filter((p) => fits(p) && p.codes?.some((c) => codes.includes(c)));
  if (byCode.length > 0) return pick(byCode);

  const text = words(name);
  let best: PortEntry[] = [];
  let bestLength = 0;
  for (const p of list) {
    if (!fits(p)) continue;
    for (const key of p.keys) {
      if (!text.includes(` ${key} `)) continue;
      if (key.length > bestLength) {
        best = [p];
        bestLength = key.length;
      } else if (key.length === bestLength && !best.includes(p)) {
        best.push(p);
      }
    }
  }
  return pick(best);
}

export function findExportPort(place: Place | null | undefined, motCode: string): PortMatch | null {
  if (!place) return null;
  const country = toCountryCode(place.country);
  if (country && country !== "US") return null;
  return match(PORTS, place, toUsStateCode(place.state), modeOf(motCode));
}

export function findUnladingPort(place: Place | null | undefined, motCode: string): PortMatch | null {
  if (!place || modeOf(motCode) === "air") return null;
  return match(FOREIGN_PORTS, place, toCountryCode(place.country), "");
}

export function isAirportPlace(place: Place | null | undefined): boolean {
  if (!place) return false;
  if (findExportPort(place, "")?.airport) return true;
  return /\b(AIRPORT|ARPT|AIRFIELD)\b/i.test(place.name ?? "");
}
