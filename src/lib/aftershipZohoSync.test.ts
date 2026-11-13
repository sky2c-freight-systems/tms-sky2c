import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * syncAftershipToZoho against an in-memory database, with the two Zoho writes mocked so
 * each test sees exactly what would be sent to the ticket.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ shipments: [] as Row[], syncs: [] as Row[], trackings: [] as Row[] }));
const zoho = vi.hoisted(() => ({ enabled: true, fields: [] as [string, Record<string, string>][], comments: [] as [string, string][] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    domesticWarehouseShipment: {
      findMany: async () => [...db.shipments].sort((a, b) => (b.createdAt as number) - (a.createdAt as number)),
    },
    zohoSync: {
      findMany: async ({ where }: { where: { fileNumber: { in: string[] } } }) =>
        db.syncs.filter((s) => where.fileNumber.in.includes(s.fileNumber as string)),
    },
    aftershipTracking: {
      findUnique: async ({ where }: { where: Row }) => db.trackings.find((t) => t.trackingNumber === where.trackingNumber) ?? null,
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const t = db.trackings.find((x) => x.trackingNumber === where.trackingNumber);
        if (t) Object.assign(t, update);
        else db.trackings.push({ ...create });
      },
    },
  },
}));

vi.mock("@/lib/pdf/renderToPdf", () => ({ renderHtmlToPdf: async () => Buffer.from("") }));

vi.mock("@/lib/zohoDeskApi", () => ({
  isAftershipZohoUpdateEnabled: () => zoho.enabled,
  updateTicketFieldsFromAftership: async (id: string, cf: Record<string, string>) => {
    zoho.fields.push([id, cf]);
  },
  addPrivateTicketComment: async (id: string, content: string) => {
    zoho.comments.push([id, content]);
  },
}));

const { syncAftershipToZoho, aftershipTimeToDate, normalizeTrackingNumber } = await import("./aftershipZohoSync");

const DISPATCH = "145882000106928698";

function shipment(overrides: Row = {}): Row {
  return {
    id: "a".repeat(24),
    fileNumber: "101061555-1",
    proNumber: "0888219312",
    zohoTicketId: "T-1",
    zohoLayoutName: "Dispatch to Warehouse",
    zohoDepartmentId: DISPATCH,
    createdAt: 1,
    ...overrides,
  };
}

function webhook(msg: Row = {}) {
  return {
    event: "tracking_update",
    msg: {
      tracking_number: "888219312",
      slug: "estes",
      tag: "InTransit",
      subtag_message: "In Transit",
      shipment_pickup_date: "2026-11-05T10:15:00",
      latest_estimated_delivery: { type: "specific", datetime: "2026-11-07", datetime_max: null },
      checkpoints: [
        { checkpoint_time: "2026-11-05T10:15:00", location: "SOUTHINGTON, CT", message: "Picked up" },
        { checkpoint_time: "2026-11-05T22:40:00", location: "WALLINGFORD, CT", message: "Departed terminal" },
      ],
      ...msg,
    },
  };
}

beforeEach(() => {
  db.shipments = [shipment()];
  db.syncs = [{ fileNumber: "101061555-1", zohoTicketId: "T-1", ticketStatus: "Open" }];
  db.trackings = [];
  zoho.enabled = true;
  zoho.fields = [];
  zoho.comments = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("helpers", () => {
  it("normalizes leading zeros, spaces and dashes", () => {
    expect(normalizeTrackingNumber(" 0888-219 312 ")).toBe("888219312");
  });

  it("reads zoneless AfterShip times as US Pacific, across DST", () => {
    expect(aftershipTimeToDate("2026-11-05T10:15:00")!.toISOString()).toBe("2026-11-05T18:15:00.000Z"); // PST
    expect(aftershipTimeToDate("2026-07-01T10:15:00")!.toISOString()).toBe("2026-07-01T17:15:00.000Z"); // PDT
    expect(aftershipTimeToDate("2026-11-07")!.toISOString()).toBe("2026-11-07T08:00:00.000Z");
    expect(aftershipTimeToDate("2026-11-07T12:11:11+01:00")!.toISOString()).toBe("2026-11-07T11:11:11.000Z");
    expect(aftershipTimeToDate(null)).toBeNull();
  });
});

describe("syncAftershipToZoho", () => {
  it("matches the Pro Number and writes Pickup Date, ETA at Warehouse and a private comment", async () => {
    await syncAftershipToZoho(webhook());
    expect(zoho.fields).toEqual([
      ["T-1", { cf_pickup_date: "2026-11-05T18:15:00.000Z", cf_eta_at_warehouse: "2026-11-07T08:00:00.000Z" }],
    ]);
    expect(zoho.comments).toHaveLength(1);
    expect(zoho.comments[0][0]).toBe("T-1");
    expect(zoho.comments[0][1]).toBe(
      "AfterShip update: In Transit\nDeparted terminal\nWALLINGFORD, CT · 5 Nov 2026 22:40\nCarrier: ESTES · Tracking: 888219312"
    );
  });

  it("uses the Port fields for Dispatch to Port and Warehouse to Port", async () => {
    db.shipments = [shipment({ zohoLayoutName: "Dispatch to Port" })];
    await syncAftershipToZoho(webhook());
    expect(Object.keys(zoho.fields[0][1])).toEqual(["cf_pickup_date", "cf_eta_for_port_drop"]);

    db.shipments = [shipment({ zohoLayoutName: "Warehouse to Port" })];
    db.trackings = [];
    zoho.fields = [];
    await syncAftershipToZoho(webhook());
    expect(Object.keys(zoho.fields[0][1])).toEqual(["cf_warehouse_pickup_date", "cf_eta_for_port_drop"]);
  });

  it("does nothing on a repeat webhook with the same values and status", async () => {
    await syncAftershipToZoho(webhook());
    zoho.fields = [];
    zoho.comments = [];
    await syncAftershipToZoho(webhook({ checkpoints: [{ message: "Arrived at terminal" }] }));
    expect(zoho.fields).toEqual([]);
    expect(zoho.comments).toEqual([]);
  });

  it("comments only when the status changes, and sends only the changed field", async () => {
    await syncAftershipToZoho(webhook());
    zoho.fields = [];
    zoho.comments = [];
    await syncAftershipToZoho(
      webhook({ tag: "Delivered", subtag_message: "Delivered", latest_estimated_delivery: { datetime: "2026-11-08" } })
    );
    expect(zoho.fields).toEqual([["T-1", { cf_eta_at_warehouse: "2026-11-08T08:00:00.000Z" }]]);
    expect(zoho.comments[0][1]).toMatch(/^AfterShip update: Delivered/);
  });

  it("falls back to the end of the ETA range, then the courier's ETA", async () => {
    await syncAftershipToZoho(webhook({ latest_estimated_delivery: { type: "range", datetime: null, datetime_max: "2026-11-09T12:00:00" } }));
    expect(zoho.fields[0][1].cf_eta_at_warehouse).toBe("2026-11-09T20:00:00.000Z");

    db.trackings = [];
    zoho.fields = [];
    await syncAftershipToZoho(
      webhook({ latest_estimated_delivery: null, courier_estimated_delivery_date: { estimated_delivery_date: "2026-11-10" } })
    );
    expect(zoho.fields[0][1].cf_eta_at_warehouse).toBe("2026-11-10T08:00:00.000Z");
  });

  it("never clears a field when AfterShip has no value", async () => {
    await syncAftershipToZoho(webhook({ shipment_pickup_date: null, latest_estimated_delivery: null }));
    expect(zoho.fields).toEqual([]);
    expect(zoho.comments).toHaveLength(1);
  });

  it("skips non-Dispatch tickets, unknown Pro Numbers and placeholders", async () => {
    db.shipments = [shipment({ zohoDepartmentId: "other", zohoLayoutName: "Via Warehouse" })];
    await syncAftershipToZoho(webhook());
    db.shipments = [shipment()];
    await syncAftershipToZoho(webhook({ tracking_number: "999999999" }));
    db.shipments = [shipment({ proNumber: "NA" })];
    await syncAftershipToZoho(webhook({ tracking_number: "NA" }));
    expect(zoho.fields).toEqual([]);
    expect(zoho.comments).toEqual([]);
  });

  it("updates only the newest open ticket when a Pro Number is on several", async () => {
    db.shipments = [
      shipment({ id: "1".repeat(24), fileNumber: "OLD", zohoTicketId: "T-OLD", createdAt: 1 }),
      shipment({ id: "2".repeat(24), fileNumber: "NEW-CLOSED", zohoTicketId: "T-CLOSED", createdAt: 3 }),
      shipment({ id: "3".repeat(24), fileNumber: "MID", zohoTicketId: "T-MID", createdAt: 2 }),
    ];
    db.syncs = [
      { fileNumber: "OLD", ticketStatus: "Open" },
      { fileNumber: "NEW-CLOSED", ticketStatus: "Closed" },
      { fileNumber: "MID", ticketStatus: "Open" },
    ];
    await syncAftershipToZoho(webhook());
    expect(zoho.fields.map(([id]) => id)).toEqual(["T-MID"]);
    expect(zoho.comments.map(([id]) => id)).toEqual(["T-MID"]);
  });

  it("only logs (dry run) while AFTERSHIP_ZOHO_UPDATE_ENABLED is off, and doesn't remember anything", async () => {
    zoho.enabled = false;
    await syncAftershipToZoho(webhook());
    expect(zoho.fields).toEqual([]);
    expect(zoho.comments).toEqual([]);
    expect(db.trackings).toEqual([]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("dry run"));
  });

  it("never throws on a garbage payload", async () => {
    await expect(syncAftershipToZoho("nope")).resolves.toBeUndefined();
    await expect(syncAftershipToZoho({ msg: { tracking_number: 12 } })).resolves.toBeUndefined();
  });
});
