import { createHash, timingSafeEqual } from "crypto";

/**
 * API-key auth for the Zoho Desk widget routes (/api/zoho/*), which are called through
 * Zoho's request proxy and so carry no TMS session. The key lives only in the
 * ZOHO_WIDGET_API_KEY env var; when it's unset every call is rejected. Both sides are
 * hashed first so the comparison is constant-time regardless of length.
 */
export function isValidWidgetApiKey(request: Request): boolean {
  const expected = process.env.ZOHO_WIDGET_API_KEY;
  const given = request.headers.get("x-api-key");
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
