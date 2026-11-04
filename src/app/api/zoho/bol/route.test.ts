import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/zoho/bol against the real route and the real BOL generator (src/lib/pickupBol.ts),
 * with the database and the Chromium renderer swapped for in-memory fakes.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  shipments: [] as Row[],
  syncs: [] as Row[],
  docs: [] as Row[],
}));

vi.mock("@/lib/prisma", () => {
  let nextId = 1;
  const newId = () => String(nextId++).padStart(24, "0");
  return {
    prisma: {
      zohoSync: {
        findFirst: async ({ where }: { where: Row }) =>
          db.syncs.find((s) => s.zohoTicketNumber === where.zohoTicketNumber && s.fileNumber) ?? null,
      },
      domesticWarehouseShipment: {
        findUnique: async ({ where }: { where: Row }) => db.shipments.find((s) => s.fileNumber === where.fileNumber) ?? null,
        findFirst: async ({ where }: { where: Row }) => db.shipments.find((s) => s.zohoTicketId === where.zohoTicketId) ?? null,
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const s = db.shipments.find((x) => x.id === where.id)!;
          Object.assign(s, data);
          return { ...s };
        },
      },
      client: {
        findUnique: async ({ where }: { where: Row }) => (where.id === "c".repeat(24) ? { name: "Acme Trucking" } : null),
      },
      generatedDocument: {
        create: async ({ data }: { data: Row }) => {
          const doc: Row = { ...data, id: newId(), createdAt: new Date() };
          db.docs.push(doc);
          return { id: doc.id, fileName: doc.fileName, source: doc.source, createdAt: doc.createdAt };
        },
        findUnique: async ({ where }: { where: Row }) => db.docs.find((d) => d.id === where.id) ?? null,
      },
    },
  };
});

vi.mock("@/lib/clientService", () => ({
  findOrCreateClient: async ({ name }: { name: string }) => ({ id: "c".repeat(24), name }),
}));

vi.mock("@/lib/pdf/renderToPdf", () => ({
  renderHtmlToPdf: async () => Buffer.from("%PDF-1.4\n% fake BOL for tests\n%%EOF"),
}));

const { POST, GET } = await import("./route");

const KEY = "test-key-0123456789abcdef";

function dispatchShipment(overrides: Row = {}): Row {
  return {
    id: "a".repeat(24),
    fileNumber: "101060001-1",
    zohoTicketId: "162539000119145087",
    zohoDepartmentId: null,
    zohoLayoutName: "Dispatch to Port",
    zohoFields: { cf_ref_number: "1010553981", cf_port_drop_location: "LAX Cargo Terminal" },
    carrierId: null,
    carrierPicklist: "Estes",
    placeOfReceipt: "123 Main St, Fresno CA",
    warehouseLocation: null,
    contactDetails: "John 555-0100",
    dockHours: "8AM-4PM",
    soNumber: "SO-77",
    preferredPickupAt: new Date("2026-11-05T17:00:00Z"),
    pickupInstructions: null,
    palletsDimensions: "1@48x40x50",
    cargoDescription: "Auto parts",
    grossWeight: 500,
    stackableTurnable: [],
    ...overrides,
  };
}

function post(body: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers["X-API-Key"] = key;
  return POST(
    new Request("http://localhost/api/zoho/bol", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  process.env.ZOHO_WIDGET_API_KEY = KEY;
  db.shipments = [dispatchShipment()];
  db.syncs = [{ zohoTicketId: "162539000119145087", zohoTicketNumber: "227400", fileNumber: "101060001-1" }];
  db.docs = [];
});

describe("auth", () => {
  it("rejects a missing key", async () => {
    const res = await post({ ticketNumber: "227400" }, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
  });

  it("rejects a wrong key", async () => {
    const res = await post({ ticketNumber: "227400" }, "wrong");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
  });

  it("rejects every key when ZOHO_WIDGET_API_KEY is unset", async () => {
    delete process.env.ZOHO_WIDGET_API_KEY;
    const res = await post({ ticketNumber: "227400" }, "");
    expect(res.status).toBe(401);
  });

  it("passes with the right key", async () => {
    const res = await post({ ticketNumber: "227400" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/zoho/bol", () => {
  it("returns bolId, fileName, createdAt and a base64 PDF", async () => {
    const res = await post({ ticketNumber: "227400" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["bolId", "createdAt", "fileName", "pdfBase64"]);
    expect(json.bolId).toBe(db.docs[0].id);
    expect(json.fileName).toMatch(/^BOL_1010553981_\d{8}-\d{6}\.pdf$/);
    expect(new Date(json.createdAt).toISOString()).toBe(json.createdAt);
    expect(Buffer.from(json.pdfBase64, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("gives every generate a new bolId", async () => {
    const a = await (await post({ ticketNumber: "227400" })).json();
    const b = await (await post({ ticketNumber: "227400" })).json();
    expect(a.bolId).not.toBe(b.bolId);
  });

  it("falls back to ticketId when the ticket number has no match", async () => {
    const res = await post({ ticketNumber: "999999", ticketId: "162539000119145087" });
    expect(res.status).toBe(200);
  });

  it("404s when no shipment matches", async () => {
    const res = await post({ ticketNumber: "111111" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No shipment found for ticket 111111" });
  });

  it("matches the ticket number exactly, not as a search", async () => {
    const res = await post({ ticketNumber: "2274" });
    expect(res.status).toBe(404);
  });

  it("400s for a non-Dispatch ticket", async () => {
    db.shipments = [dispatchShipment({ zohoLayoutName: "Via Warehouse" })];
    const res = await post({ ticketNumber: "227400" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "BOL generation is only for Dispatch tickets" });
  });

  it("422s with the missing field labels", async () => {
    db.shipments = [dispatchShipment({ dockHours: null, soNumber: null })];
    const res = await post({ ticketNumber: "227400" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Please fill: Dock Hours, SO Number" });
    expect(db.docs).toHaveLength(0);
  });

  it("saves sent fields, so a BOL can be generated after filling them", async () => {
    db.shipments = [dispatchShipment({ dockHours: null })];
    const res = await post({ ticketNumber: "227400", fields: { cf_dock_hours: "9AM-5PM" } });
    expect(res.status).toBe(200);
    expect(db.shipments[0].dockHours).toBe("9AM-5PM");
  });

  it("maps the widget fields the same way as the webhook", async () => {
    const res = await post({
      ticketNumber: "227400",
      fields: {
        cf_ref_number: "REF-9",
        cf_carrier_picklist: "Other",
        cf_carrier: "Acme Trucking",
        cf_pickup_location: "1 Dock Rd",
        cf_preferred_pickup_date: "2026-11-06",
        cf_variable_2: "SO-88",
        cf_commodity_detail: "Machinery",
        cf_gross_weight: "1,250.5",
        cf_pallets_x_dimensions: "2@48x40x40",
        cf_stackable_and_turnable: "Stackable;Hazardous/DG",
        cf_port_drop_location: "SFO Terminal 2",
        cf_warehouse_pickup_instructions: "Call ahead",
      },
    });
    expect(res.status).toBe(200);
    const s = db.shipments[0];
    expect(s.carrierPicklist).toBe("Other");
    expect(s.carrierId).toBe("c".repeat(24));
    expect(s.placeOfReceipt).toBe("1 Dock Rd");
    expect((s.preferredPickupAt as Date).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(s.soNumber).toBe("SO-88");
    expect(s.cargoDescription).toBe("Machinery");
    expect(s.grossWeight).toBe(1250.5);
    expect(s.palletsDimensions).toBe("2@48x40x40");
    expect(s.stackableTurnable).toEqual(["Stackable", "Hazardous/DG"]);
    expect(s.zohoFields).toMatchObject({
      cf_ref_number: "REF-9",
      cf_port_drop_location: "SFO Terminal 2",
      cf_warehouse_pickup_instructions: "Call ahead",
    });
  });

  it("leaves TMS values alone for field keys that aren't sent (or are empty)", async () => {
    const res = await post({ ticketNumber: "227400", fields: { cf_dock_hours: "10AM-2PM", cf_variable_2: "" } });
    expect(res.status).toBe(200);
    const s = db.shipments[0];
    expect(s.dockHours).toBe("10AM-2PM");
    expect(s.soNumber).toBe("SO-77");
    expect(s.contactDetails).toBe("John 555-0100");
    expect(s.grossWeight).toBe(500);
    expect(s.zohoFields).toEqual({ cf_ref_number: "1010553981", cf_port_drop_location: "LAX Cargo Terminal" });
  });

  it("400s for an unknown field", async () => {
    const res = await post({ ticketNumber: "227400", fields: { cf_something_else: "x" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown field: cf_something_else" });
  });

  it("400s for a non-numeric weight and a bad date", async () => {
    const w = await post({ ticketNumber: "227400", fields: { cf_gross_weight: "heavy" } });
    expect(w.status).toBe(400);
    expect(await w.json()).toEqual({ error: "cf_gross_weight must be a number" });
    const d = await post({ ticketNumber: "227400", fields: { cf_preferred_pickup_date: "next week" } });
    expect(d.status).toBe(400);
    expect((await d.json()).error).toMatch(/^cf_preferred_pickup_date must be a date/);
    expect(db.shipments[0].grossWeight).toBe(500);
  });

  it("400s for bad JSON and a missing ticketNumber", async () => {
    const bad = await post("{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Request body must be JSON" });
    const missing = await post({ fields: {} });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "ticketNumber is required" });
  });

  it("returns JSON 500 without details when generation fails", async () => {
    const pdf = await import("@/lib/pdf/renderToPdf");
    vi.spyOn(pdf, "renderHtmlToPdf").mockRejectedValueOnce(new Error("chromium crashed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ ticketNumber: "227400" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to generate BOL" });
    errSpy.mockRestore();
  });

  it("answers other methods with JSON 405", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });
});
