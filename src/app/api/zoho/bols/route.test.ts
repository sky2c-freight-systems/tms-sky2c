import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /api/zoho/bols against the real route and listPickupBols, with an in-memory database. */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ shipments: [] as Row[], syncs: [] as Row[], docs: [] as Row[], users: [] as Row[] }));

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
      findMany: async ({ where }: { where: { shipmentId?: string; docType?: string; id?: { in: string[] } } }) => {
        if (where.id) return db.docs.filter((d) => where.id!.in.includes(d.id as string));
        return db.docs
          .filter((d) => d.shipmentId === where.shipmentId && d.docType === where.docType)
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
      },
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => db.users.filter((u) => where.id.in.includes(u.id as string)),
    },
  },
}));

vi.mock("@/lib/pdf/renderToPdf", () => ({ renderHtmlToPdf: async () => Buffer.from("") }));

const { GET, POST } = await import("./route");

const KEY = "test-key-0123456789abcdef";
const SHIPMENT_ID = "a".repeat(24);
const USER_ID = "b".repeat(24);

function get(query: string, key: string | null = KEY) {
  return GET(new Request(`http://localhost/api/zoho/bols${query}`, { headers: key ? { "x-api-key": key } : {} }));
}

beforeEach(() => {
  process.env.ZOHO_WIDGET_API_KEY = KEY;
  db.shipments = [{ id: SHIPMENT_ID, fileNumber: "101062076" }];
  db.syncs = [{ zohoTicketNumber: "237962", fileNumber: "101062076" }];
  db.users = [{ id: USER_ID, displayName: "Dispatch User" }];
  db.docs = [
    { id: "1".repeat(24), shipmentId: SHIPMENT_ID, docType: "pickup-bol", fileName: "BOL_old.pdf", source: "AUTO", createdBy: null, createdAt: new Date("2026-11-12T09:05:01Z") },
    { id: "2".repeat(24), shipmentId: SHIPMENT_ID, docType: "pickup-bol", fileName: "BOL_new.pdf", source: "MANUAL", createdBy: USER_ID, createdAt: new Date("2026-11-13T17:30:12Z") },
    { id: "3".repeat(24), shipmentId: "other", docType: "pickup-bol", fileName: "BOL_other.pdf", source: "MANUAL", createdBy: null, createdAt: new Date() },
  ];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/zoho/bols", () => {
  it("lists the ticket's BOLs newest first with the creator's name", async () => {
    const res = await get("?ticketNumber=237962");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      fileNumber: "101062076",
      bols: [
        { bolId: "2".repeat(24), fileName: "BOL_new.pdf", source: "MANUAL", createdAt: "2026-11-13T17:30:12.000Z", createdBy: "Dispatch User" },
        { bolId: "1".repeat(24), fileName: "BOL_old.pdf", source: "AUTO", createdAt: "2026-11-12T09:05:01.000Z", createdBy: null },
      ],
    });
  });

  it("returns an empty list for a shipment with no BOLs", async () => {
    db.docs = [];
    const res = await get("?ticketNumber=237962");
    expect(await res.json()).toEqual({ fileNumber: "101062076", bols: [] });
  });

  it("matches the ticket number exactly", async () => {
    const res = await get("?ticketNumber=2379");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No shipment for ticket 2379" });
  });

  it("rejects a missing or wrong key and a missing ticketNumber", async () => {
    expect((await get("?ticketNumber=237962", null)).status).toBe(401);
    const bad = await get("?ticketNumber=237962", "wrong");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "Invalid API key" });
    const missing = await get("");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "ticketNumber is required" });
  });

  it("answers other methods with 405", async () => {
    const res = POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
