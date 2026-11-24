import { describe, expect, it } from "vitest";
import { parsePlaceText } from "@/lib/aes/places";

describe("parsePlaceText", () => {
  it("reads city and US state", () => {
    expect(parsePlaceText("Los Angeles, CA")).toEqual({ head: "Los Angeles", state: "CA", country: "US", portCode: "" });
    expect(parsePlaceText("Reno, Nevada, USA")).toEqual({ head: "Reno", state: "NV", country: "US", portCode: "" });
  });

  it("reads a state from a street address and ignores the ZIP as a port code", () => {
    expect(parsePlaceText("1 Main St, Hayward, CA 94545")).toEqual({ head: "1 Main St", state: "CA", country: "US", portCode: "" });
  });

  it("takes a port code only when alone or in brackets", () => {
    expect(parsePlaceText("Oakland (2811)").portCode).toBe("2811");
    expect(parsePlaceText("53305", { foreign: true }).portCode).toBe("53305");
    expect(parsePlaceText("Port 2811 Road, Oakland").portCode).toBe("");
  });

  it("treats 2-letter codes as countries for destinations", () => {
    expect(parsePlaceText("Mumbai, IN", { foreign: true })).toEqual({ head: "Mumbai", state: "", country: "IN", portCode: "" });
    expect(parsePlaceText("Indianapolis, IN")).toEqual({ head: "Indianapolis", state: "IN", country: "US", portCode: "" });
    expect(parsePlaceText("Nhava Sheva, India", { foreign: true }).country).toBe("IN");
    expect(parsePlaceText("Toronto, ON, Canada", { foreign: true }).country).toBe("CA");
  });

  it("returns empty parts for empty or plain text", () => {
    expect(parsePlaceText("")).toEqual({ head: "", state: "", country: "", portCode: "" });
    expect(parsePlaceText(null)).toEqual({ head: "", state: "", country: "", portCode: "" });
    expect(parsePlaceText("Oakland")).toEqual({ head: "Oakland", state: "", country: "", portCode: "" });
  });
});
