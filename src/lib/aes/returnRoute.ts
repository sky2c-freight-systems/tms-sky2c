import { NONCE_PATTERN, recordReturn, requestMeta, type ReturnOutcome, type ReturnResult } from "@/lib/aes/audit";

/**
 * Logic behind the nonce-bearing CBP return route
 *   /api/aes/return/<success|failure|status>/<fileNumber>/<nonce>
 * (kept apart from the route file so it can be checked with fakes).
 *
 * The route is PUBLIC (a cross-site POST from CBP carries no Lax cookie). It records CBP's
 * result only when the nonce matches an AesSubmission for the same file number and kind
 * (see recordReturn), then 303-redirects to the staff-only AES page. The redirect is built
 * the same way whether or not anything matched or was written, so the route reveals nothing
 * about which file numbers or nonces exist. A database failure never blocks the redirect.
 */

const OUTCOMES = new Set<ReturnOutcome>(["success", "failure", "status"]);
const FILE_NUMBER = /^[A-Za-z0-9-]{1,30}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const MAX_PARAMS = 25;
const MAX_VALUE_LEN = 200;

/** CBP's parameters from the query string and (for POST) a form body, bounded like the original route. */
export async function collectReturnParams(request: Request): Promise<Array<[string, string]>> {
  const url = new URL(request.url);
  const raw: Array<[string, string]> = [...url.searchParams.entries()];
  if (request.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    try {
      if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
        const form = await request.formData();
        for (const [k, v] of form.entries()) if (typeof v === "string") raw.push([k, v]);
      }
    } catch {
      // Malformed body — keep whatever the query string carried.
    }
  }
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [name, value] of raw) {
    if (out.length >= MAX_PARAMS || !PARAM_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push([name, value.slice(0, MAX_VALUE_LEN)]);
  }
  return out;
}

export interface ReturnRouteDeps {
  recordReturn?: (input: Parameters<typeof recordReturn>[0]) => Promise<ReturnResult>;
}

export async function processNonceReturn(
  request: Request,
  route: { outcome: string; fileNumber: string; nonce: string },
  deps: ReturnRouteDeps = {}
): Promise<{ location: URL; result: ReturnResult | null }> {
  const origin = new URL(request.url).origin;
  const { outcome, fileNumber, nonce } = route;

  if (!OUTCOMES.has(outcome as ReturnOutcome) || !FILE_NUMBER.test(fileNumber)) {
    return { location: new URL("/shipments", origin), result: null };
  }

  const params = await collectReturnParams(request);
  let result: ReturnResult | null = null;
  try {
    result = await (deps.recordReturn ?? recordReturn)({
      nonce,
      outcome: outcome as ReturnOutcome,
      fileNumber,
      method: request.method,
      params,
      meta: requestMeta(request.headers),
    });
  } catch (err) {
    // recordReturn never throws, but the redirect must survive anything.
    console.error("[aes-audit] return recording failed", fileNumber, err);
  }

  const target = new URL(`/shipments/${encodeURIComponent(fileNumber)}/aes`, origin);
  target.searchParams.set("aes_return", outcome);
  // Always forwarded (when well-formed), matched or not: the AES page — behind staff auth —
  // looks the nonce up itself to show a verified result.
  if (NONCE_PATTERN.test(nonce)) target.searchParams.set("aes_n", nonce);
  for (const [name, value] of params) target.searchParams.set(`cbp_${name}`, value);
  return { location: target, result };
}
