import { NextResponse } from "next/server";

/**
 * Backward-compatibility shim. The first AES build (2026-10-22) gave CBP return URLs of the form
 * /api/aes/weblink/return?fn=<fileNumber>&o=success|failure. A filing started from that build may
 * still come back here, so this forwards to the current path-based route
 * (/api/aes/return/<outcome>/<fileNumber>), keeping every parameter CBP appended.
 * Safe to delete this file (and its folder) once no such filings can be in flight.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fileNumber = url.searchParams.get("fn") ?? "";
  const outcome = url.searchParams.get("o") === "failure" ? "failure" : "success";

  if (!/^[A-Za-z0-9-]{1,30}$/.test(fileNumber)) {
    return NextResponse.redirect(new URL("/shipments", url.origin), 303);
  }

  const target = new URL(`/api/aes/return/${outcome}/${encodeURIComponent(fileNumber)}`, url.origin);
  for (const [name, value] of url.searchParams) {
    if (name !== "fn" && name !== "o") target.searchParams.append(name, value);
  }
  return NextResponse.redirect(target, 303);
}
