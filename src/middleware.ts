import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";
import type { CustomerSessionData } from "@/lib/customerSession";

// Duplicated literally (not imported as a runtime value) rather than importing
// CUSTOMER_SESSION_COOKIE_NAME from customerSession.ts — that module also imports
// next/headers, which isn't available in middleware's Edge runtime. Same reason the
// staff cookie name ("dwtms_session") below is a literal instead of importing
// session.ts's constant. Keep this in sync with customerSession.ts if it ever changes.

const PUBLIC_PATHS = ["/login", "/api/auth/login"];

// Zoho/QuickBooks webhook endpoints authenticate themselves (shared-secret header /
// OAuth callback) rather than via the interactive session cookie — see each route.
const WEBHOOK_PREFIXES = ["/api/webhooks/zoho", "/api/quickbooks/callback"];

// Customer-facing shipment tracking, intentionally reachable without a login the same
// way any carrier's tracking page is. The route itself returns only milestone/routing
// data — never pricing, client records or invoices — so possessing a tracking number
// grants no access to commercial detail. See src/app/api/tracking/[code]/route.ts.
const PUBLIC_PREFIXES = ["/tracking", "/api/tracking"];

// CBP AESDirect WebLink return URLs. CBP sends the user's browser back here after a filing
// or status inquiry; a cross-site POST wouldn't carry the Lax staff cookie, and an expired
// session must not lose CBP's result. These routes touch no data — they only redirect to
// the AES page, which stays behind staff auth. See src/app/api/aes/return/.
const AES_RETURN_PREFIXES = ["/api/aes/return", "/api/aes/weblink/return"];

// Customer portal: registration/login themselves must be reachable without a customer
// session (that's the whole point), but everything else under /customer and
// /api/customer requires one — see the branch below, which is a SEPARATE session/cookie
// from internal staff auth (src/lib/customerSession.ts), never the staff "dwtms_session".
const CUSTOMER_PUBLIC_PREFIXES = [
  "/customer/login",
  "/customer/register",
  "/api/customer/login",
  "/api/customer/register",
];
const CUSTOMER_AREA_PREFIXES = ["/customer", "/api/customer"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.includes(pathname) ||
    WEBHOOK_PREFIXES.some((p) => pathname.startsWith(p)) ||
    AES_RETURN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    CUSTOMER_PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  if (CUSTOMER_AREA_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const response = NextResponse.next();
    const customerSession = await getIronSession<CustomerSessionData>(request, response, {
      password: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me-32bytes!!",
      cookieName: "dwtms_customer_session",
      cookieOptions: { secure: process.env.NODE_ENV === "production" },
    });

    if (!customerSession.customerAccountId) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/customer/login", request.url));
    }

    return response;
  }

  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, {
    password: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me-32bytes!!",
    cookieName: "dwtms_session",
    cookieOptions: { secure: process.env.NODE_ENV === "production" },
  });

  if (!session.userId) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    // Keep the query string too (e.g. CBP's ITN/STA on the AES page) so it survives a login.
    loginUrl.searchParams.set("from", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
