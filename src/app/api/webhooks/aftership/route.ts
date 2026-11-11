import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * AfterShip tracking webhook — receive and log only for now (nothing is saved). The token
 * comes from `?token=` on the registered URL or the `aftershiptoken` header and is checked
 * against AFTERSHIP_WEBHOOK_TOKEN. Always returns 200, even on a bad token, so AfterShip
 * doesn't keep retrying (same rule as the Zoho webhooks).
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.AFTERSHIP_WEBHOOK_TOKEN;
  const given = new URL(request.url).searchParams.get("token") || request.headers.get("aftershiptoken");
  if (!expected || !given) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    console.warn("[aftership] rejected: invalid or missing token");
    return NextResponse.json({ received: true }, { status: 200 });
  }
  console.log(`[aftership] webhook received: ${await request.text()}`);
  return NextResponse.json({ received: true }, { status: 200 });
}
