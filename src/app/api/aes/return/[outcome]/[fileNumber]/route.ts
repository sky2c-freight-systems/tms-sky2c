import { NextResponse } from "next/server";

/**
 * Where CBP AESDirect WebLink sends the user's browser back:
 *   /api/aes/return/success/<fileNumber>  ← wl_success_url (filing)
 *   /api/aes/return/failure/<fileNumber>  ← wl_nosed_url   (filing)
 *   /api/aes/return/status/<fileNumber>   ← URL            (weblinkFilingInquiry)
 * CBP appends its own parameters (the legacy Sky2CWeb read SRN, ITN, STA from the query string).
 *
 * PUBLIC on purpose (listed in middleware): a cross-site POST back from ace.cbp.dhs.gov would
 * not carry the SameSite=Lax staff cookie, and an expired session must not lose CBP's result.
 * It is therefore display-only plumbing: no DB access (so it can't be used to probe which file
 * numbers exist), nothing persisted, nothing trusted. It only 303-redirects to the AES page,
 * which IS behind staff auth (middleware keeps the query string through a login).
 */

const OUTCOMES = new Set(["success", "failure", "status"]);
const FILE_NUMBER = /^[A-Za-z0-9-]{1,30}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const MAX_PARAMS = 25;
const MAX_VALUE_LEN = 200;

async function collectParams(request: Request): Promise<Array<[string, string]>> {
  const url = new URL(request.url);
  const params: Array<[string, string]> = [...url.searchParams.entries()];
  if (request.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    try {
      if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
        const form = await request.formData();
        for (const [k, v] of form.entries()) if (typeof v === "string") params.push([k, v]);
      }
    } catch {
      // Malformed body — fall through with whatever the query string carried.
    }
  }
  return params;
}

async function handle(request: Request, { params }: { params: Promise<{ outcome: string; fileNumber: string }> }) {
  const { outcome, fileNumber } = await params;
  const origin = new URL(request.url).origin;

  if (!OUTCOMES.has(outcome) || !FILE_NUMBER.test(fileNumber)) {
    return NextResponse.redirect(new URL("/shipments", origin), 303);
  }

  const target = new URL(`/shipments/${encodeURIComponent(fileNumber)}/aes`, origin);
  target.searchParams.set("aes_return", outcome);

  let forwarded = 0;
  for (const [name, value] of await collectParams(request)) {
    if (forwarded >= MAX_PARAMS || !PARAM_NAME.test(name)) continue;
    target.searchParams.set(`cbp_${name}`, value.slice(0, MAX_VALUE_LEN));
    forwarded += 1;
  }

  console.info(`[aes] CBP ${outcome} return for ${fileNumber}`, [...target.searchParams.entries()]);
  return NextResponse.redirect(target, 303);
}

export const GET = handle;
export const POST = handle;
