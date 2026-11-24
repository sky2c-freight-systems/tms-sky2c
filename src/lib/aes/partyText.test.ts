import { describe, expect, it } from "vitest";
import { parsePartyText } from "@/lib/aes/partyText";

describe("parsePartyText", () => {
  it("reads a multi-line block", () => {
    expect(parsePartyText("Ravi Kumar\nNo 12, 3rd Cross, MG Road\nChennai - 600001\nTamil Nadu, India\nPh: +91 98400 12345\nravi@example.com")).toEqual({
      name: "Ravi Kumar", line1: "No 12, 3rd Cross, MG Road", line2: "", city: "Chennai", postal: "600001", country: "IN", phone: "+91 98400 12345",
    });
  });

  it("drops a state line after the postal line", () => {
    const p = parsePartyText("ABC Exports\n5 Ring Road\nNew Delhi 110 001\nDelhi\nIndia");
    expect(p).toMatchObject({ name: "ABC Exports", line1: "5 Ring Road", city: "New Delhi", postal: "110001", country: "IN" });
  });

  it("reads a single comma-separated line", () => {
    expect(parsePartyText("Ravi Kumar, 12 MG Road, Chennai 600001, India")).toMatchObject({
      name: "Ravi Kumar", line1: "12 MG Road", city: "Chennai", postal: "600001", country: "IN",
    });
  });

  it("keeps middle lines as address line 2", () => {
    expect(parsePartyText("Gulf Trading LLC\nWarehouse 7\nAl Quoz Industrial 3\nDubai\nUAE")).toMatchObject({
      line1: "Warehouse 7", line2: "Al Quoz Industrial 3", city: "Dubai", postal: "", country: "AE",
    });
  });

  it("handles a name only, a phone only and empty text", () => {
    expect(parsePartyText("Ravi Kumar")).toMatchObject({ name: "Ravi Kumar", line1: "", city: "" });
    expect(parsePartyText("Mobile: 98400 12345")).toMatchObject({ name: "", phone: "98400 12345" });
    expect(parsePartyText("  ")).toBeNull();
    expect(parsePartyText(null)).toBeNull();
  });

  it("does not treat a company name as a phone label or a country", () => {
    expect(parsePartyText("Mobile Traders\n1 High St\nLondon N1 9GU\nUK")).toMatchObject({ name: "Mobile Traders", line1: "1 High St", country: "GB" });
  });
});
