import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /api/zoho/bol/[bolId] against the real route, with an in-memory database. */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ shipments: [] as Row[], syncs: [] as Row[], docs: [] as Row[] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    zohoSync: {
      findFirst: async ({ where }: { where: Row }) =>
        db.syncs.find((s) => s.zohoTicketNumber === where.zohoTicketNumber && s.fileNumber) ?? null,
    },
    domesticWarehouseShipment: {
      findUnique: async ({ where }: { where: Row }) => db.shipments.find((s) => s.fileNumber === where.fileNumber) ?? null,
    },
    generatedDocument: {
      findFirst: async ({ where }: { where: Row }) =>
        db.docs.find((d) => d.id === where.id && d.shipmentId === where.shipmentId && d.docType === where.docType) ?? null,
    },
  },
}));

vi.mock("@/lib/pdf/renderToPdf", () => ({ renderHtmlToPdf: async () => Buffer.from("") }));

const { GET, DELETE } = await import("./route");

const KEY = "test-key-0123456789abcdef";
const PDF = Buffer.from("%PDF-1.4\n% fake\n%%EOF");
const MINE = "1".repeat(24);
const OTHERS = "2".repeat(24);

function get(bolId: string, query = "?ticketNumber=237962", key: string | null = KEY) {
  return GET(new Request(`http://localhost/api/zoho/bol/${bolId}${query}`, { headers: key ? { "x-api-key": key } : {} }), {
    params: Promise.resolve({ bolId }),
  });
}

beforeEach(() => {
  process.env.ZOHO_WIDGET_API_KEY = KEY;
  db.shipments = [
    { id: "a".repeat(24), fileNumber: "101062076" },
    { id: "b".repeat(24), fileNumber: "101062077" },
  ];
  db.syncs = [
    { zohoTicketNumber: "237962", fileNumber: "101062076" },
    { zohoTicketNumber: "237963", fileNumber: "101062077" },
  ];
  db.docs = [
    { id: MINE, shipmentId: "a".repeat(24), docType: "pickup-bol", fileName: "BOL_101062076.pdf", pdf: new Uint8Array(PDF) },
    { id: OTHERS, shipmentId: "b".repeat(24), docType: "pickup-bol", fileName: "BOL_101062077.pdf", pdf: new Uint8Array(PDF) },
  ];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/zoho/bol/[bolId]", () => {
  it("returns the BOL as base64", async () => {
    const res = await get(MINE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ fileName: "BOL_101062076.pdf", pdfBase64: PDF.toString("base64") });
    expect(Buffer.from(body.pdfBase64, "base64").toString()).toBe(PDF.toString());
  });

  it("404s a BOL that belongs to another ticket's shipment", async () => {
    const res = await get(OTHERS);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s an unknown ticket, an unknown BOL and a malformed id", async () => {
    expect((await get(MINE, "?ticketNumber=999999")).status).toBe(404);
    expect((await get("3".repeat(24))).status).toBe(404);
    const bad = await get("not-an-id");
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "Not found" });
  });

  it("rejects a wrong key and a missing ticketNumber", async () => {
    const res = await get(MINE, "?ticketNumber=237962", "wrong");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid API key" });
    expect((await get(MINE, "")).status).toBe(400);
  });

  it("answers other methods with 405", async () => {
    expect(DELETE().status).toBe(405);
  });
});
