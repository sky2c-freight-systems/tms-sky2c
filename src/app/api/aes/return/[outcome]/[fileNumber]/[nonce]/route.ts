import { NextResponse } from "next/server";
import { processNonceReturn } from "@/lib/aes/returnRoute";

/**
 * CBP AESDirect WebLink return for AUDITED hand-offs (the nonce matches the AesSubmission
 * written by POST /api/aes/handoff):
 *   /api/aes/return/success/<fileNumber>/<nonce>  ← wl_success_url (filing)
 *   /api/aes/return/failure/<fileNumber>/<nonce>  ← wl_nosed_url   (filing)
 *   /api/aes/return/status/<fileNumber>/<nonce>   ← URL            (weblinkFilingInquiry)
 *
 * PUBLIC on purpose (covered by the /api/aes/return prefix in middleware). Writes to the
 * audit only for a matching nonce, then 303s to the staff-only AES page — see
 * src/lib/aes/returnRoute.ts. The nonce-less route next door stays for hand-offs made
 * before the audit log existed (display only).
 */
async function handle(request: Request, { params }: { params: Promise<{ outcome: string; fileNumber: string; nonce: string }> }) {
  const { location } = await processNonceReturn(request, await params);
  return NextResponse.redirect(location, 303);
}

export const GET = handle;
export const POST = handle;
