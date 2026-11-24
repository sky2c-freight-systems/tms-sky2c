import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Where = Record<string, unknown> & { OR?: Where[] };

const db = vi.hoisted(() => ({
  shipment: null as Row | null,
  locations: [] as Row[],
  clients: {} as Record<string, Row>,
  containers: [] as Row[],
}));

const eq = (v: unknown, w: unknown) => String(v ?? "").toLowerCase() === String((w as { equals: string }).equals).replace(/\\(.)/g, "$1").toLowerCase();
const matches = (l: Row, w: Where): boolean => {
  if (w.isActive !== undefined && l.isActive !== w.isActive) return false;
  for (const k of ["name", "code", "city"]) if (w[k] && !eq(l[k], w[k])) return false;
  return w.OR ? w.OR.some((o) => matches(l, o)) : true;
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    domesticWarehouseShipment: { findUnique: async () => db.shipment },
    location: {
      findFirst: async ({ where }: { where: Where }) => db.locations.find((l) => matches(l, where)) ?? null,
      findMany: async ({ where }: { where: Where }) => db.locations.filter((l) => matches(l, where)),
    },
    client: { findUnique: async ({ where }: { where: Row }) => db.clients[String(where.id ?? where.clientId)] ?? null },
    cargoContainer: { findMany: async () => db.containers },
  },
}));

import { buildAesHandoff } from "@/lib/aes/aesHandoff";

const client = (o: Row): Row => ({
  clientId: "C1", name: "", street: null, addressLine1: null, addressLine2: null, city: null, state: null, zipCode: null,
  country: null, telephone: null, contact: null, contactLastName: null, exporterIdNumber: null, exporterIdType: null, scacCode: null, ...o,
});
const loc = (o: Row): Row => ({ code: null, city: null, state: null, country: "USA", isActive: true, ...o });

beforeEach(() => {
  delete process.env.AES_FILER_ID;
  delete process.env.AES_FORWARDER_CLIENT_ID;
  db.locations = [
    loc({ name: "Oakland", city: "Oakland", state: "CA", code: "2811" }),
    loc({ name: "Port of Oakland", city: "Oakland", state: "California", code: "2811" }),
    loc({ name: "Long Beach", city: "Long Beach", state: "CA", code: "2709" }),
    loc({ name: "Long Beach Terminal", city: "Long Beach", state: "CA", code: "2704" }),
    loc({ name: "Springfield IL", city: "Springfield", state: "IL" }),
    loc({ name: "Springfield MO", city: "Springfield", state: "MO" }),
    loc({ name: "Seattle", city: "Seattle", state: "WA", code: "USSEA" }),
    loc({ name: "Reno Warehouse", city: "Reno", state: "NV" }),
    loc({ name: "Fresno Yard", city: "Fresno", state: "CA", code: "1111" }),
    loc({ name: "Fresno Rail", city: "Fresno", state: "CA", code: "2222" }),
  ];
  db.clients = {
    acc: client({ clientId: "A1", name: "Acme Inc", street: "1 Main St", city: "Hayward", state: "CA", zipCode: "94545", country: "USA", telephone: "510-555-0100", contact: "Jane", contactLastName: "Doe", exporterIdNumber: "94-1234567" }),
    con: client({ clientId: "B1", name: "Buyer Ltd" }),
  };
  db.containers = [];
  db.shipment = {
    id: "s1", fileNumber: "101062771", domesticType: "TRUCK", zohoLayoutName: "Direct to Port", serviceType: "Door to Port",
    bolNumber: "B1", proNumber: "P1", country: "India", zohoFields: {}, accountId: "acc", consigneeId: "con", shipperId: null,
    shipToId: null, carrierId: null, placeOfDelivery: null, shipAt: new Date("2026-12-01T00:00:00Z"), preferredPickupAt: null,
    pickupScheduleAt: null, etaAt: null, carrierPicklist: "Fast", cargoDescription: "Machine parts", grossWeight: 1000, palletsDimensions: null,
    placeOfReceipt: "1 Dock Rd, Reno, NV 89501", origin: "Oakland, CA", destination: "Nhava Sheva, India",
  };
});

const run = async () => (await buildAesHandoff("101062771", { userEmail: "u@sky2c.com", baseUrl: "https://tms.test" }))!;

describe("place lookup from the search fields", () => {
  it("finds the port from 'City, ST' text and reads the pickup state from an address", async () => {
    const f = (await run()).mapping.fields;
    expect(f.POE).toBe("2811");
    expect(f.ST).toBe("NV");
    expect(f.COD).toBe("IN");
    expect(f.POU).toBeUndefined();
  });

  it("does not guess between two Locations with different codes", async () => {
    db.shipment!.origin = "Fresno, CA";
    expect((await run()).mapping.fields.POE).toBeUndefined();
  });

  it("uses the built-in Schedule D list when the Locations disagree", async () => {
    db.shipment!.origin = "Long Beach, CA";
    expect((await run()).mapping.fields.POE).toBe("2709");
  });

  it("does not guess between same-name places in different states", async () => {
    db.shipment!.placeOfReceipt = "Springfield";
    db.shipment!.origin = null;
    expect((await run()).mapping.fields.ST).toBeUndefined();
  });

  it("uses an exact Location name, a code in brackets or a bare code", async () => {
    db.shipment!.origin = "Port of Oakland";
    db.shipment!.placeOfReceipt = null;
    let f = (await run()).mapping.fields;
    expect([f.POE, f.ST]).toEqual(["2811", "CA"]);
    db.shipment!.origin = "Oakland (2811)";
    f = (await run()).mapping.fields;
    expect([f.POE, f.ST]).toEqual(["2811", "CA"]);
    db.shipment!.destination = "53305";
    expect((await run()).mapping.fields.POU).toBe("53305");
  });

  it("prefers a CBP port code typed in the text over a UN/LOCODE on the Location", async () => {
    db.shipment!.origin = "Seattle (3001)";
    expect((await run()).mapping.fields.POE).toBe("3001");
    db.shipment!.origin = "Seattle";
    expect((await run()).mapping.fields.POE).toBe("3001");
  });
});

describe("auto-filled values", () => {
  it("uses the shipment Gross Weight and Commodity Detail when there are no cargo items", async () => {
    const h = await run();
    expect(h.mapping.fields).toMatchObject({ IT1_12: "MACHINE PARTS", IT1_7: "454" });
    expect(h.mapping.fields.IT1_2).toBeUndefined();
  });

  it("reads the Zoho AWB, Consignee Details and pallet count", async () => {
    db.shipment!.domesticType = "DOMESTIC_AIR";
    db.shipment!.zohoFields = { cf_awb: "098-12345675", cf_consignee_details: "Buyer Ltd\n7 Link Rd\nMumbai 400001\nIndia" };
    db.shipment!.palletsDimensions = "4 @ 40x48x50";
    const f = (await run()).mapping.fields;
    expect(f).toMatchObject({ MOT: "40", BN: "098-12345675", SCAC: "AI", VN: "Air India", AD1_8: "7 Link Rd", AD1_10: "Mumbai", AD1_13: "400001", IT1_4: "4" });
  });

  it("takes the truck carrier's SCAC from its client record for Mexico", async () => {
    db.clients.trk = client({ clientId: "T1", name: "Fast Trucking", scacCode: "FSTK" });
    db.shipment!.carrierId = "trk";
    db.shipment!.destination = "Monterrey, Mexico";
    db.shipment!.country = "Mexico";
    expect((await run()).mapping.fields).toMatchObject({ COD: "MX", MOT: "30", SCAC: "FSTK", VN: "Fast Trucking", BN: "P1" });
  });

  it("files a truck shipment to China as Vessel from the seaport", async () => {
    db.shipment!.origin = "Oakland, CA";
    db.shipment!.destination = "Shanghai, China";
    db.shipment!.country = "China";
    const f = (await run()).mapping.fields;
    expect(f).toMatchObject({ MOT: "10", POE: "2811", POU: "57035", COD: "CN" });
    expect(f.SCAC).toBeUndefined();
  });

  it("takes the exporter EIN from the Account client record", async () => {
    expect((await run()).mapping.fields).toMatchObject({ AD0_1: "Acme Inc", AD0_2: "941234567", AD0_3: "E" });
  });

  it("gives the consignee the destination country when its record has none", async () => {
    expect((await run()).mapping.fields.AD1_12).toBe("IN");
  });

  it("sends the built-in Sky2C agent and enables the status check without any settings", async () => {
    const h = await run();
    expect(h.mapping.fields).toMatchObject({ AD3_4: "943355318", AD3_3: "SKY 2 C FREIGHT SYSTEMS INC", AD3_8: "1500 ATLANTIC ST", AD3_10: "UNION CITY", AD3_13: "94587" });
    expect(h.inquiry?.fields).toMatchObject({ FID: "943355318", SRN: "101062771" });
    expect(h.inquiry?.returnsToTms).toBe(true);
  });

  it("uses Sky2C's client record when AES_FORWARDER_CLIENT_ID is set", async () => {
    process.env.AES_FORWARDER_CLIENT_ID = "SKY2C1";
    db.clients.SKY2C1 = client({ clientId: "SKY2C1", name: "Sky2C Ops", street: "9 Ops Way", city: "Union City", state: "CA", zipCode: "94587", country: "USA" });
    const f = (await run()).mapping.fields;
    expect([f.AD3_3, f.AD3_8]).toEqual(["Sky2C Ops", "9 Ops Way"]);
  });

  it("gives the same fields hash on repeat builds (page vs send)", async () => {
    expect((await run()).fieldsHash).toBe((await run()).fieldsHash);
  });
});
