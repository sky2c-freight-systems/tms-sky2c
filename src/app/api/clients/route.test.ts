import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ clients: [] as Row[], qboPushes: 0 }));

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ userId: "u".repeat(24) }) }));
vi.mock("@/lib/numbering", () => ({ generateClientId: async (name: string) => `${name.slice(0, 4)}1` }));
vi.mock("@/lib/qbo", () => ({ ensureCustomerInQBO: async () => { db.qboPushes += 1; } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      create: async ({ data }: { data: Row }) => {
        const c = { id: "c".repeat(24), ...data };
        db.clients.push(c);
        return c;
      },
      findUnique: async ({ where }: { where: Row }) => db.clients.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const c = db.clients.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return { ...c };
      },
    },
  },
}));

import { POST } from "@/app/api/clients/route";
import { PATCH } from "@/app/api/clients/[id]/route";

const post = (body: unknown) => POST(new Request("http://t/api/clients", { method: "POST", body: JSON.stringify(body) }));
const patch = (body: unknown) =>
  PATCH(new Request("http://t/api/clients/x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "c".repeat(24) }) });

beforeEach(() => {
  db.clients = [];
  db.qboPushes = 0;
});

describe("client EIN for AES", () => {
  it("creates a client without an EIN exactly as before", async () => {
    const res = await post({ name: "Acme Inc", city: "Hayward", roles: ["ACCOUNT"] });
    expect(res.status).toBe(201);
    const c = db.clients[0];
    expect(c).toMatchObject({ name: "Acme Inc", city: "Hayward", isCustomer: true, clientId: "Acme1" });
    expect(c.exporterIdNumber).toBeUndefined();
    expect(c.exporterIdType).toBeUndefined();
  });

  it("saves the EIN and its type on create", async () => {
    await post({ name: "Acme Inc", exporterIdNumber: " 94-1234567 ", exporterIdType: "E" });
    expect(db.clients[0]).toMatchObject({ exporterIdNumber: "94-1234567", exporterIdType: "E" });
  });

  it("treats an empty EIN type as not set", async () => {
    const res = await post({ name: "Acme Inc", exporterIdNumber: "", exporterIdType: "" });
    expect(res.status).toBe(201);
    expect(db.clients[0].exporterIdNumber).toBeUndefined();
    expect(db.clients[0].exporterIdType).toBeUndefined();
  });

  it("rejects an unknown EIN type", async () => {
    expect((await post({ name: "Acme Inc", exporterIdType: "X" })).status).toBe(400);
  });

  it("updates and clears the EIN without touching other fields", async () => {
    await post({ name: "Acme Inc", city: "Hayward", accountingEmailAddress: "ap@acme.test" });
    let res = await patch({ exporterIdNumber: "94-1234567", exporterIdType: "D" });
    expect(res.status).toBe(200);
    expect(db.clients[0]).toMatchObject({ exporterIdNumber: "94-1234567", exporterIdType: "D", city: "Hayward", accountingEmailAddress: "ap@acme.test" });
    res = await patch({ exporterIdNumber: "", exporterIdType: "" });
    expect(db.clients[0]).toMatchObject({ exporterIdNumber: null, exporterIdType: null, city: "Hayward" });
    expect(db.qboPushes).toBe(0);
  });

  it("leaves the EIN alone when a patch doesn't mention it", async () => {
    await post({ name: "Acme Inc", exporterIdNumber: "941234567", exporterIdType: "E" });
    await patch({ city: "Fremont" });
    expect(db.clients[0]).toMatchObject({ exporterIdNumber: "941234567", exporterIdType: "E", city: "Fremont" });
  });
});

describe("carrier SCAC for AES", () => {
  it("saves the SCAC upper case and treats empty as not set", async () => {
    await post({ name: "Fast Trucking", scacCode: " fstk " });
    expect(db.clients[0].scacCode).toBe("FSTK");
    await post({ name: "Slow Trucking", scacCode: "" });
    expect(db.clients[1].scacCode).toBeUndefined();
  });

  it("rejects a SCAC that isn't 2-4 letters", async () => {
    expect((await post({ name: "Fast Trucking", scacCode: "FST12" })).status).toBe(400);
  });

  it("updates, clears and keeps the SCAC", async () => {
    await post({ name: "Fast Trucking" });
    await patch({ scacCode: "abcd" });
    expect(db.clients[0].scacCode).toBe("ABCD");
    await patch({ city: "Fremont" });
    expect(db.clients[0].scacCode).toBe("ABCD");
    await patch({ scacCode: "" });
    expect(db.clients[0].scacCode).toBeNull();
  });
});
