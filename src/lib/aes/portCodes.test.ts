import { describe, expect, it } from "vitest";
import { findExportPort, findUnladingPort, isAirportPlace } from "@/lib/aes/portCodes";

const us = (name: string, o: { code?: string | null; state?: string | null; country?: string | null } = {}) => ({ name, code: null, state: null, country: "US", ...o });

describe("findExportPort", () => {
  it("matches a port name or a UN/LOCODE", () => {
    expect(findExportPort(us("Port of Oakland"), "10")?.code).toBe("2811");
    expect(findExportPort(us("Oakland Terminal", { code: "USOAK" }), "30")?.code).toBe("2811");
    expect(findExportPort(us("Long Beach, CA", { state: "CA" }), "31")?.code).toBe("2709");
  });

  it("picks the airport code for air", () => {
    expect(findExportPort(us("Los Angeles", { state: "CA" }), "40")?.code).toBe("2720");
    expect(findExportPort(us("Los Angeles", { state: "CA" }), "30")?.code).toBe("2704");
    expect(findExportPort(us("LAX"), "30")?.code).toBe("2720");
    expect(findExportPort(us("San Francisco International Airport"), "30")?.code).toBe("2801");
    expect(findExportPort(us("Seattle", { code: "USSEA" }), "40")?.code).toBe("3029");
    expect(findExportPort(us("Chicago O'Hare (ORD)"), "40")?.code).toBe("3901");
  });

  it("needs the state for shared city names", () => {
    expect(findExportPort(us("Portland"), "10")).toBeNull();
    expect(findExportPort(us("Portland, OR", { state: "OR" }), "10")?.code).toBe("2904");
    expect(findExportPort(us("Portland, ME", { state: "ME" }), "10")).toBeNull();
    expect(findExportPort(us("Newark", { state: "CA" }), "30")).toBeNull();
    expect(findExportPort(us("Newark", { state: "NJ" }), "30")?.code).toBe("4601");
  });

  it("never matches a foreign place, an unknown place or an unknown mode split", () => {
    expect(findExportPort(us("Oakland", { country: "India" }), "10")).toBeNull();
    expect(findExportPort(us("Fresno"), "30")).toBeNull();
    expect(findExportPort(us("San Francisco"), "")).toBeNull();
    expect(findExportPort(null, "10")).toBeNull();
  });

  it("does not read IATA codes out of ordinary words", () => {
    expect(findExportPort(us("Sea Port Warehouse"), "40")).toBeNull();
  });
});

describe("findUnladingPort", () => {
  it("matches foreign seaports by name or UN/LOCODE", () => {
    expect(findUnladingPort({ name: "Shanghai, China", country: "CN" }, "11")?.code).toBe("57035");
    expect(findUnladingPort({ name: "Terminal", code: "DEHAM", country: "Germany" }, "30")?.code).toBe("42879");
    expect(findUnladingPort({ name: "Port of Antwerp" }, "30")?.code).toBe("42305");
  });

  it("needs the country for shared names and skips air", () => {
    expect(findUnladingPort({ name: "Vancouver" }, "10")).toBeNull();
    expect(findUnladingPort({ name: "Vancouver", country: "Canada" }, "10")?.code).toBe("12493");
    expect(findUnladingPort({ name: "Shanghai", country: "CN" }, "40")).toBeNull();
    expect(findUnladingPort({ name: "Nhava Sheva", country: "IN" }, "10")).toBeNull();
  });
});

describe("isAirportPlace", () => {
  it("knows airports from the list or the name", () => {
    expect(isAirportPlace(us("SFO"))).toBe(true);
    expect(isAirportPlace(us("San Francisco International Airport"))).toBe(true);
    expect(isAirportPlace(us("Chicago O'Hare Airport"))).toBe(true);
    expect(isAirportPlace(us("Port of Oakland"))).toBe(false);
    expect(isAirportPlace(us("San Francisco"))).toBe(false);
    expect(isAirportPlace(null)).toBe(false);
  });
});
