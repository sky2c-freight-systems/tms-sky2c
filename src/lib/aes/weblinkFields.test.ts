import { describe, expect, it } from "vitest";
import { buildWeblinkFields, type AesCargoItem, type AesMappingInput, type AesParty } from "@/lib/aes/weblinkFields";

const party = (o: Partial<AesParty>): AesParty => ({
  clientId: "X1", name: "", street: null, addressLine1: null, addressLine2: null, city: null, state: null,
  zipCode: null, country: null, telephone: null, contact: null, contactLastName: null, ...o,
});
const item = (o: Partial<AesCargoItem>): AesCargoItem => ({
  description: "Pump parts", numberOfPieces: 3, pieceType: "CTN", grossWeightLbs: null, grossWeightKgs: 100,
  declaredValueCents: 1200000, isVehicle: false, vehicleMake: null, vehicleModel: null, vehicleTitle: null, vehicleState: null, ...o,
});
const shipment = (o: Partial<AesMappingInput["shipment"]> = {}): AesMappingInput["shipment"] => ({
  fileNumber: "101062771-1", domesticType: "TRUCK", zohoLayoutName: "Direct to Port", serviceType: "Door to Port",
  bolNumber: "BOL778", proNumber: "PRO55", country: "India", destination: "Nhava Sheva", placeOfReceipt: "Reno Warehouse",
  origin: "Oakland", placeOfDelivery: null, shipAt: new Date("2026-12-01T00:00:00Z"), preferredPickupAt: null,
  pickupScheduleAt: null, etaAt: null, cargoDescription: "Machine parts", grossWeightLbs: 1000, carrierPicklist: "Fast", zohoAwb: null,
  consigneeDetails: null, palletsDimensions: null, ...o,
});

function input(o: Partial<AesMappingInput> = {}): AesMappingInput {
  return {
    shipment: shipment(),
    shipper: party({ name: "Shipper Co", state: "NV", country: "USA" }),
    account: party({ clientId: "A1", name: "Acme Inc", street: "1 Main St", city: "Hayward", state: "California", zipCode: "94545", country: "USA", telephone: "1-510-555-0100", contact: "Jane", contactLastName: "Doe", idNumber: "94-1234567", idType: "E" }),
    consignee: party({ clientId: "B1", name: "Buyer Ltd", street: "2 Port Rd", city: "Mumbai", country: "India", telephone: "+91 22 5555 0000" }),
    shipTo: party({ name: "ShipTo GmbH", street: "3 Weg", city: "Hamburg", country: "Germany" }),
    carrier: party({ clientId: "T1", name: "Fast Trucking", scac: "fstk" }),
    forwarder: party({ clientId: "", name: "SKY 2 C FREIGHT SYSTEMS INC", street: "1500 ATLANTIC ST", city: "UNION CITY", state: "CA", zipCode: "94587", country: "US", telephone: "5107433300" }),
    filerId: "943355318",
    containers: [{ containerNumber: "MSKU1234567", seal1: "S1", items: [item({})] }],
    portOfExportCode: "2811",
    portOfUnladingCode: "53305",
    pickupLocation: { name: "Reno Warehouse", code: null, state: "NV", country: "USA", matched: true },
    originPort: { name: "Oakland", code: "2811", state: "CA", country: "USA", matched: true },
    destinationPort: { name: "Nhava Sheva", code: "53305", state: null, country: "India", matched: true },
    responseEmail: "ops@sky2c.com",
    successUrl: "https://tms/s",
    failureUrl: "https://tms/f",
    today: new Date("2026-11-22T00:00:00Z"),
    ...o,
  };
}
const row = (r: ReturnType<typeof buildWeblinkFields>, code: string) => r.rows.find((x) => x.code === code);
const missingRequired = (r: ReturnType<typeof buildWeblinkFields>) =>
  r.rows.filter((x) => x.required && (x.status === "missing" || x.status === "not-in-tms")).map((x) => x.code);

describe("shipment fields", () => {
  it("maps ports, date, state and destination", () => {
    const f = buildWeblinkFields(input()).fields;
    expect(f).toMatchObject({ POE: "2811", POU: "53305", EDA: "12/01/2026", ST: "NV", COD: "IN", SRN: "101062771C1" });
  });

  it("takes the state from the Origin Port when the Pickup Location has none", () => {
    const r = buildWeblinkFields(input({ pickupLocation: null }));
    expect(r.fields.ST).toBe("CA");
    expect(row(r, "ST")?.source).toMatch(/Origin Port/);
  });

  it("says when a place was read from the text", () => {
    const r = buildWeblinkFields(input({ originPort: { name: "Oakland, CA", code: null, state: "CA", country: "US", matched: false }, pickupLocation: null }));
    expect(row(r, "ST")?.source).toMatch(/from the text/);
  });

  it("falls back from consignee to destination port to shipment country", () => {
    expect(buildWeblinkFields(input({ consignee: party({ name: "Buyer" }) })).fields.COD).toBe("IN");
    expect(buildWeblinkFields(input({ consignee: party({ name: "Buyer" }), destinationPort: null, shipment: shipment({ country: "Germany" }) })).fields.COD).toBe("DE");
  });

  it("fills the agreed defaults", () => {
    const r = buildWeblinkFields(input());
    expect(r.fields).toMatchObject({ IBT: "70", RT: "N", HAZ: "N", EP1_1: "N", AMS1_1: "N", IT1_1: "OS", IT1_21: "D", IT1_8: "C33", FO: "2", AD1_14: "O", AD1_6: "N" });
    for (const code of ["IT1_21", "IT1_8", "AD1_14", "IT1_1"]) expect(row(r, code)?.status).toBe("derived");
    expect(r.fields.IBN).toBeUndefined();
    expect(r.fields.FTZ).toBeUndefined();
  });
});

describe("port codes", () => {
  it("finds the port of export by name when the Location has no CBP code", () => {
    const r = buildWeblinkFields(input({ portOfExportCode: "", originPort: { name: "Port of Oakland", code: "USOAK", state: "CA", country: "US", matched: true } }));
    expect(r.fields.POE).toBe("2811");
    expect(row(r, "POE")?.status).toBe("derived");
    expect(row(r, "POE")?.source).toMatch(/Schedule D/);
  });

  it("uses the airport code for air and the city code otherwise", () => {
    const sf = { name: "San Francisco, CA", code: null, state: "CA", country: "US", matched: false };
    expect(buildWeblinkFields(input({ portOfExportCode: "", originPort: sf, shipment: shipment({ domesticType: "DOMESTIC_AIR" }) })).fields.POE).toBe("2801");
    expect(buildWeblinkFields(input({ portOfExportCode: "", originPort: sf })).fields.POE).toBe("2809");
  });

  it("leaves an unknown port for AESDirect", () => {
    const r = buildWeblinkFields(input({ portOfExportCode: "", originPort: { name: "Fresno Yard", code: null, state: "CA", country: "US", matched: false } }));
    expect(r.fields.POE).toBeUndefined();
    expect(row(r, "POE")?.note).toMatch(/pick the port in AESDirect/);
  });

  it("finds the port of unlading from the built-in Schedule K list", () => {
    const r = buildWeblinkFields(input({ portOfUnladingCode: "", destinationPort: { name: "Shanghai", code: "CNSHA", state: null, country: "China", matched: true } }));
    expect(r.fields.POU).toBe("57035");
    expect(row(r, "POU")?.status).toBe("derived");
  });
});

describe("mode and carrier", () => {
  const mexico = party({ clientId: "B2", name: "Comprador SA", street: "Av Reforma 100", city: "Monterrey", state: "NL", country: "Mexico" });

  it("uses Truck or Rail from the Domestic Type for Canada and Mexico", () => {
    expect(buildWeblinkFields(input({ containers: [], consignee: mexico })).fields.MOT).toBe("30");
    expect(buildWeblinkFields(input({ consignee: mexico })).fields.MOT).toBe("31");
    expect(buildWeblinkFields(input({ containers: [], consignee: mexico, shipment: shipment({ domesticType: "RAIL" }) })).fields.MOT).toBe("20");
    const r = buildWeblinkFields(input({ containers: [], consignee: mexico, shipment: shipment({ domesticType: "PICKUP" }) }));
    expect(r.fields.MOT).toBe("30");
    expect(row(r, "MOT")?.source).toMatch(/Default Truck/);
  });

  it("uses Vessel for other destinations from a seaport", () => {
    const r = buildWeblinkFields(input({ containers: [] }));
    expect(r.fields.MOT).toBe("10");
    expect(row(r, "MOT")?.source).toMatch(/Leaves by ship/);
    expect(buildWeblinkFields(input()).fields.MOT).toBe("11");
    expect(buildWeblinkFields(input({ containers: [], shipment: shipment({ domesticType: "RAIL" }) })).fields.MOT).toBe("10");
  });

  it("uses Air when the Origin Port is an airport or there is an AWB", () => {
    const sfo = { name: "San Francisco International Airport", code: null, state: "CA", country: "US", matched: false };
    const r = buildWeblinkFields(input({ containers: [], portOfExportCode: "", originPort: sfo }));
    expect(r.fields).toMatchObject({ MOT: "40", POE: "2801" });
    expect(buildWeblinkFields(input({ containers: [], shipment: shipment({ zohoAwb: "176-12345675" }) })).fields.MOT).toBe("40");
    expect(buildWeblinkFields(input({ containers: [], shipment: shipment({ domesticType: "DOMESTIC_AIR" }) })).fields.MOT).toBe("40");
  });

  it("uses the shipment's carrier, SCAC and PRO for truck", () => {
    const r = buildWeblinkFields(input({ consignee: mexico }));
    expect(r.fields).toMatchObject({ SCAC: "FSTK", VN: "Fast Trucking", BN: "PRO55" });
    expect(buildWeblinkFields(input({ consignee: mexico, shipment: shipment({ proNumber: null }) })).fields.BN).toBe("BOL778");
  });

  it("falls back to the Carrier-Name picklist and asks for the SCAC", () => {
    const r = buildWeblinkFields(input({ carrier: null, consignee: mexico }));
    expect(r.fields.VN).toBe("Fast");
    expect(r.fields.SCAC).toBeUndefined();
    expect(row(r, "SCAC")?.status).toBe("not-in-tms");
  });

  it("leaves the ocean carrier, vessel name and booking for AESDirect", () => {
    const r = buildWeblinkFields(input());
    expect([r.fields.SCAC, r.fields.VN, r.fields.BN]).toEqual([undefined, undefined, undefined]);
    expect(row(r, "SCAC")?.note).toMatch(/ocean carrier's SCAC/);
    expect(row(r, "VN")?.note).toMatch(/vessel name/);
    expect(row(r, "BN")?.note).toMatch(/booking number/);
  });

  it("uses the airline from the AWB prefix for air", () => {
    const r = buildWeblinkFields(input({ shipment: shipment({ domesticType: "DOMESTIC_AIR", zohoAwb: "176-12345675" }) }));
    expect(r.fields).toMatchObject({ SCAC: "EK", VN: "Emirates", BN: "176-12345675" });
    expect(row(r, "SCAC")?.status).toBe("derived");
  });

  it("does not send an unknown airline", () => {
    const r = buildWeblinkFields(input({ shipment: shipment({ domesticType: "DOMESTIC_AIR", zohoAwb: "555-12345675" }) }));
    expect(r.fields.SCAC).toBeUndefined();
    expect(r.fields.VN).toBeUndefined();
  });
});

describe("parties", () => {
  it("uses the Account as exporter, not the shipper", () => {
    const f = buildWeblinkFields(input()).fields;
    expect(f).toMatchObject({ AD0_1: "Acme Inc", AD0_4: "1 Main St", AD0_6: "Hayward", AD0_7: "CA", AD0_8: "94545", AD0_9: "Jane", AD0_11: "Doe", AD0_12: "5105550100" });
  });

  it("splits a full contact name when there is no last name", () => {
    const r = buildWeblinkFields(input({ account: party({ name: "Acme", contact: "Mary Ann Smith" }) }));
    expect(r.fields).toMatchObject({ AD0_9: "Mary Ann", AD0_11: "Smith" });
    expect(row(r, "AD0_11")?.status).toBe("derived");
  });

  it("leaves the exporter missing when there is no Account", () => {
    const r = buildWeblinkFields(input({ account: null }));
    expect(r.fields.AD0_1).toBeUndefined();
    expect(row(r, "AD0_1")?.status).toBe("missing");
  });

  it("takes the exporter EIN from the Account (normalised) and defaults the type to EIN", () => {
    const r = buildWeblinkFields(input({ account: party({ name: "Acme", idNumber: "94-1234567", idType: null }) }));
    expect(r.fields).toMatchObject({ AD0_2: "941234567", AD0_3: "E" });
    expect(row(r, "AD0_2")?.source).toBe("Account (EIN)");
  });

  it("does not send an invalid Account EIN", () => {
    const r = buildWeblinkFields(input({ account: party({ name: "Acme", idNumber: "12-34" }) }));
    expect(r.fields.AD0_2).toBeUndefined();
    expect(row(r, "AD0_2")?.note).toMatch(/isn't 9-11/);
  });

  it("marks related parties only when the Account and Consignee are the same", () => {
    expect(buildWeblinkFields(input()).fields.RCC).toBe("N");
    const same = party({ clientId: "A1", name: "Acme Inc" });
    expect(buildWeblinkFields(input({ consignee: same })).fields.RCC).toBe("Y");
    expect(buildWeblinkFields(input({ consignee: party({ clientId: "Z9", name: "ACME, Inc." }) })).fields.RCC).toBe("Y");
  });

  it("uses only the Consignee (no Ship To fallback)", () => {
    const r = buildWeblinkFields(input({ consignee: null }));
    expect(r.fields.AD1_3).toBeUndefined();
    expect(r.fields.AD1_10).toBeUndefined();
  });

  it("gives a consignee without a country the destination country", () => {
    const r = buildWeblinkFields(input({ consignee: party({ name: "Buyer", street: "2 Port Rd", city: "Mumbai", telephone: "022 5555 0000" }) }));
    expect(r.fields.AD1_12).toBe("IN");
    expect(row(r, "AD1_12")?.source).toMatch(/Destination country/);
  });

  it("fills a bare consignee from the Zoho Consignee Details text", () => {
    const details = "Ravi Kumar\n12 MG Road\nChennai - 600001\nTamil Nadu, India\nPh: +91 98400 12345";
    const r = buildWeblinkFields(input({ consignee: party({ name: "Ravi Kumar" }), shipment: shipment({ consigneeDetails: details }) }));
    expect(r.fields).toMatchObject({ AD1_3: "Ravi Kumar", AD1_8: "12 MG Road", AD1_10: "Chennai", AD1_13: "600001", AD1_12: "IN", AD1_7: "919840012345" });
    expect(row(r, "AD1_8")?.status).toBe("derived");
    expect(row(r, "AD1_3")?.source).toBe("Consignee");
  });

  it("keeps the consignee record's address over the Zoho text", () => {
    const r = buildWeblinkFields(input({ shipment: shipment({ consigneeDetails: "Other Name\n9 Other St\nDelhi 110001\nIndia" }) }));
    expect(r.fields).toMatchObject({ AD1_3: "Buyer Ltd", AD1_8: "2 Port Rd", AD1_10: "Mumbai" });
  });

  it("never sends an intermediate consignee", () => {
    const f = buildWeblinkFields(input()).fields;
    expect(Object.keys(f).filter((k) => k.startsWith("AD4_"))).toEqual([]);
  });

  it("sends Sky2C as the authorized agent", () => {
    const r = buildWeblinkFields(input());
    expect(r.fields).toMatchObject({ AD3_2: "E", AD3_4: "943355318", AD3_3: "SKY 2 C FREIGHT SYSTEMS INC", AD3_8: "1500 ATLANTIC ST", AD3_10: "UNION CITY", AD3_11: "CA", AD3_12: "US", AD3_13: "94587", AD3_7: "5107433300" });
    expect(row(r, "AD3_3")?.source).toBe("Sky2C (built in)");
  });
});

describe("goods lines", () => {
  it("maps description, value, weight and pieces from the cargo item", () => {
    const r = buildWeblinkFields(input());
    expect(r.fields).toMatchObject({ IT1_12: "PUMP PARTS", IT1_2: "12000", IT1_7: "100", IT1_4: "3" });
    expect(row(r, "IT1_4")?.status).toBe("derived");
  });

  it("falls back to Commodity Detail when the cargo item has no description", () => {
    const r = buildWeblinkFields(input({ containers: [{ containerNumber: null, seal1: null, items: [item({ description: "" })] }] }));
    expect(r.fields.IT1_12).toBe("MACHINE PARTS");
    expect(row(r, "IT1_12")?.source).toBe("Commodity Detail");
  });

  it("uses the shipment Gross Weight and pallet count when there are no cargo items", () => {
    const r = buildWeblinkFields(input({ containers: [], shipment: shipment({ palletsDimensions: "2 @ 48x40x50\n1 @ 40x40x40" }) }));
    expect(r.fields).toMatchObject({ IT1_12: "MACHINE PARTS", IT1_7: "454", IT1_4: "3" });
    expect(r.fields.IT1_2).toBeUndefined();
    expect(row(r, "IT1_2")?.note).toMatch(/Fill in AESDirect/);
  });

  it("does not spread the shipment Gross Weight over several lines", () => {
    const two = [{ containerNumber: null, seal1: null, items: [item({ grossWeightKgs: null }), item({ grossWeightKgs: 50 })] }];
    const f = buildWeblinkFields(input({ containers: two })).fields;
    expect(f.IT1_7).toBeUndefined();
    expect(f.IT2_7).toBe("50");
  });

  it("asks for the Schedule B and VIN in AESDirect", () => {
    const r = buildWeblinkFields(input({ containers: [{ containerNumber: null, seal1: null, items: [item({ isVehicle: true, vehicleTitle: "T1", vehicleState: "California" })] }] }));
    expect(row(r, "IT1_13")?.status).toBe("not-in-tms");
    expect(row(r, "IT1_17")?.status).toBe("not-in-tms");
    expect(r.fields).toMatchObject({ IT1_15: "Y", IT1_18: "T1", IT1_19: "CA" });
  });
});

describe("whole filing", () => {
  it("leaves only Schedule B for AESDirect when a truck export is complete", () => {
    const mexico = party({ clientId: "B2", name: "Comprador SA", street: "Av Reforma 100", city: "Monterrey", state: "NL", country: "Mexico" });
    expect(missingRequired(buildWeblinkFields(input({ consignee: mexico })))).toEqual(["IT1_13"]);
  });

  it("leaves Schedule B, ocean carrier and vessel name for AESDirect on a vessel export", () => {
    expect(missingRequired(buildWeblinkFields(input()))).toEqual(["SCAC", "VN", "IT1_13"]);
  });

  it("keeps every value within 45 characters", () => {
    const f = buildWeblinkFields(input()).fields;
    expect(Object.entries(f).filter(([k, v]) => !k.startsWith("wl_") && k !== "EMAIL" && v.length > 45)).toEqual([]);
  });
});
