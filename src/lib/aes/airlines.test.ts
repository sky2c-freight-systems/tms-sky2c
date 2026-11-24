import { describe, expect, it } from "vitest";
import { airlineFromAwb } from "@/lib/aes/airlines";

describe("airlineFromAwb", () => {
  it("reads the airline from the AWB prefix", () => {
    expect(airlineFromAwb("176-12345675")).toEqual({ prefix: "176", iata: "EK", name: "Emirates" });
    expect(airlineFromAwb("098 1234 5675")?.iata).toBe("AI");
    expect(airlineFromAwb("16012345675")?.iata).toBe("CX");
  });

  it("returns null for unknown prefixes or other text", () => {
    expect(airlineFromAwb("555-12345675")).toBeNull();
    expect(airlineFromAwb("176-1234")).toBeNull();
    expect(airlineFromAwb("MAEU123456789")).toBeNull();
    expect(airlineFromAwb(null)).toBeNull();
  });
});
