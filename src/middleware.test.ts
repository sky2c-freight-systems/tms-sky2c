import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

/** The widget API key opens /api/zoho/* only — never a session-protected route. */
describe("middleware and the Zoho widget API key", () => {
  const key = { "X-API-Key": "any-key-value" };

  it("lets /api/zoho/* through to the route's own key check", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/zoho/bol", { method: "POST", headers: key }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still requires a session on /api/shipments with an API key", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/shipments", { headers: key }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthenticated" });
  });

  it("still requires a session on /api/shipments/{fileNumber}/bol with an API key", async () => {
    const res = await middleware(
      new NextRequest("http://localhost/api/shipments/101060001-1/bol", { method: "POST", headers: key })
    );
    expect(res.status).toBe(401);
  });
});
