import { describe, expect, it } from "vitest";
import { toCountryCode } from "@/lib/aes/codes";

describe("toCountryCode", () => {
  it("returns ISO codes, never old aliases", () => {
    expect(toCountryCode("France")).toBe("FR");
    expect(toCountryCode("United Kingdom")).toBe("GB");
    expect(toCountryCode("UK")).toBe("GB");
    expect(toCountryCode("Serbia")).toBe("RS");
    expect(toCountryCode("Benin")).toBe("BJ");
    expect(toCountryCode("FX")).toBe("");
  });

  it("keeps the usual names and codes working", () => {
    expect(toCountryCode("India")).toBe("IN");
    expect(toCountryCode("IN")).toBe("IN");
    expect(toCountryCode("United States")).toBe("US");
    expect(toCountryCode("USA")).toBe("US");
    expect(toCountryCode("Germany")).toBe("DE");
    expect(toCountryCode("UAE")).toBe("AE");
    expect(toCountryCode("")).toBe("");
  });
});
