// Airline from the air waybill prefix (first 3 digits of the AWB). Pure.

const AIRLINES: Record<string, { iata: string; name: string }> = {
  "001": { iata: "AA", name: "American Airlines" },
  "006": { iata: "DL", name: "Delta Air Lines" },
  "014": { iata: "AC", name: "Air Canada" },
  "016": { iata: "UA", name: "United Airlines" },
  "020": { iata: "LH", name: "Lufthansa Cargo" },
  "023": { iata: "FX", name: "FedEx" },
  "027": { iata: "AS", name: "Alaska Airlines" },
  "047": { iata: "TP", name: "TAP Air Portugal" },
  "053": { iata: "EI", name: "Aer Lingus" },
  "057": { iata: "AF", name: "Air France" },
  "065": { iata: "SV", name: "Saudia" },
  "071": { iata: "ET", name: "Ethiopian Airlines" },
  "074": { iata: "KL", name: "KLM" },
  "075": { iata: "IB", name: "Iberia" },
  "077": { iata: "MS", name: "EgyptAir" },
  "079": { iata: "PR", name: "Philippine Airlines" },
  "081": { iata: "QF", name: "Qantas" },
  "086": { iata: "NZ", name: "Air New Zealand" },
  "098": { iata: "AI", name: "Air India" },
  "105": { iata: "AY", name: "Finnair" },
  "112": { iata: "CK", name: "China Cargo Airlines" },
  "114": { iata: "LY", name: "El Al" },
  "117": { iata: "SK", name: "SAS Scandinavian Airlines" },
  "125": { iata: "BA", name: "British Airways" },
  "126": { iata: "GA", name: "Garuda Indonesia" },
  "131": { iata: "JL", name: "Japan Airlines" },
  "139": { iata: "AM", name: "Aeromexico" },
  "147": { iata: "AT", name: "Royal Air Maroc" },
  "157": { iata: "QR", name: "Qatar Airways" },
  "160": { iata: "CX", name: "Cathay Pacific" },
  "172": { iata: "CV", name: "Cargolux" },
  "176": { iata: "EK", name: "Emirates" },
  "180": { iata: "KE", name: "Korean Air" },
  "205": { iata: "NH", name: "All Nippon Airways" },
  "217": { iata: "TG", name: "Thai Airways" },
  "232": { iata: "MH", name: "Malaysia Airlines" },
  "235": { iata: "TK", name: "Turkish Airlines" },
  "297": { iata: "CI", name: "China Airlines" },
  "403": { iata: "PO", name: "Polar Air Cargo" },
  "406": { iata: "5X", name: "UPS Airlines" },
  "512": { iata: "RJ", name: "Royal Jordanian" },
  "603": { iata: "UL", name: "SriLankan Airlines" },
  "607": { iata: "EY", name: "Etihad Airways" },
  "618": { iata: "SQ", name: "Singapore Airlines" },
  "695": { iata: "BR", name: "EVA Air" },
  "738": { iata: "VN", name: "Vietnam Airlines" },
  "781": { iata: "MU", name: "China Eastern Airlines" },
  "784": { iata: "CZ", name: "China Southern Airlines" },
  "810": { iata: "M6", name: "Amerijet International" },
  "880": { iata: "HU", name: "Hainan Airlines" },
  "932": { iata: "VS", name: "Virgin Atlantic" },
  "933": { iata: "KZ", name: "Nippon Cargo Airlines" },
  "988": { iata: "OZ", name: "Asiana Airlines" },
  "999": { iata: "CA", name: "Air China" },
};

export interface AwbAirline {
  prefix: string;
  iata: string;
  name: string;
}

// "176-1234 5675" -> Emirates. Null if the AWB isn't 11 digits or the prefix is unknown.
export function airlineFromAwb(awb: string | null | undefined): AwbAirline | null {
  const m = (awb ?? "").trim().match(/^(\d{3})[\s-]*(\d{4})\s*(\d{4})$/);
  if (!m) return null;
  const airline = AIRLINES[m[1]];
  return airline ? { prefix: m[1], ...airline } : null;
}
