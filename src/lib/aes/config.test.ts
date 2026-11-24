import { afterEach, describe, expect, it } from "vitest";
import { getAesConfig, SKY2C_AGENT, SKY2C_FILER_ID } from "@/lib/aes/config";

const saved = { filer: process.env.AES_FILER_ID, fwd: process.env.AES_FORWARDER_CLIENT_ID };
afterEach(() => {
  process.env.AES_FILER_ID = saved.filer;
  process.env.AES_FORWARDER_CLIENT_ID = saved.fwd;
  if (saved.filer === undefined) delete process.env.AES_FILER_ID;
  if (saved.fwd === undefined) delete process.env.AES_FORWARDER_CLIENT_ID;
});

describe("AES filer ID and agent defaults", () => {
  it("uses Sky2C's EIN when AES_FILER_ID is empty", () => {
    delete process.env.AES_FILER_ID;
    const c = getAesConfig();
    expect(c.filerId).toBe(SKY2C_FILER_ID);
    expect(c.filerId).toBe("943355318");
    expect(c.configWarnings).toEqual([]);
  });

  it("uses AES_FILER_ID when set (dashes removed)", () => {
    process.env.AES_FILER_ID = "12-3456789";
    expect(getAesConfig().filerId).toBe("123456789");
  });

  it("falls back to Sky2C's EIN with a warning when AES_FILER_ID is invalid", () => {
    process.env.AES_FILER_ID = "bad";
    const c = getAesConfig();
    expect(c.filerId).toBe(SKY2C_FILER_ID);
    expect(c.configWarnings[0]).toMatch(/isn't a valid filer ID/);
  });

  it("leaves the agent client empty so the built-in Sky2C details are used", () => {
    delete process.env.AES_FORWARDER_CLIENT_ID;
    expect(getAesConfig().forwarderClientId).toBe("");
    expect(SKY2C_AGENT).toMatchObject({ name: "SKY 2 C FREIGHT SYSTEMS INC", street: "1500 ATLANTIC ST", city: "UNION CITY", state: "CA", zipCode: "94587", country: "US" });
  });

  it("keeps test (cert) as the default environment", () => {
    const c = getAesConfig();
    expect(c.environment).toBe("cert");
    expect(c.filingUrl).toContain("trade-test");
  });
});
