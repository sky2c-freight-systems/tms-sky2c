import { NextResponse, after } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { syncAftershipToZoho } from "@/lib/aftershipZohoSync";

/**
 * AfterShip tracking webhook. The token comes from `?token=` on the registered URL or the
 * `aftershiptoken` header and is checked against AFTERSHIP_WEBHOOK_TOKEN. Always returns
 * 200, even on a bad token or a bad body, so AfterShip doesn't keep retrying (same rule as
 * the Zoho webhooks). The Zoho ticket update (src/lib/aftershipZohoSync.ts) runs after the
 * response. Only the tracking number and status are logged — the body carries customer
 * names, emails and addresses.
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
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    console.warn("[aftership] webhook received with a body that isn't JSON; ignored");
    return NextResponse.json({ received: true }, { status: 200 });
  }
  const msg = (payload as { event?: unknown; msg?: { tracking_number?: unknown; tag?: unknown } }) ?? {};
  console.log(
    `[aftership] webhook received: event=${String(msg.event ?? "?")} tracking=${String(msg.msg?.tracking_number ?? "?")} tag=${String(msg.msg?.tag ?? "?")}`
  );
  after(() => syncAftershipToZoho(payload));
  return NextResponse.json({ received: true }, { status: 200 });
}
