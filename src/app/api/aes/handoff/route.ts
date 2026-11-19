import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { buildAesHandoff, resolveAppBaseUrl } from "@/lib/aes/aesHandoff";
import { requestMeta } from "@/lib/aes/audit";
import { processHandoffRequest, type HandoffRequestBody } from "@/lib/aes/handoffRequest";

/**
 * POST /api/aes/handoff — staff only (protected by middleware like every non-public route).
 * Records the AES hand-off (AesSubmission + audit event) BEFORE the browser contacts CBP and
 * returns the exact fields to post. Body: { fileNumber, kind: "FILING" | "INQUIRY",
 * action?: "A" | "R", expectedHash?, prodAcknowledged? }. See src/lib/aes/handoffRequest.ts.
 */
export async function POST(request: Request) {
  // JSON only: a cross-site HTML form can't send it, and cross-origin fetch would need CORS.
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Expected application/json." }, { status: 415 });
  }
  let body: HandoffRequestBody;
  try {
    body = (await request.json()) as HandoffRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const session = await getSession();
  const actor = session.userId
    ? { userId: session.userId, email: session.email ?? "", name: session.displayName ?? session.email ?? "" }
    : null;
  const baseUrl = resolveAppBaseUrl(request.headers);

  try {
    const result = await processHandoffRequest(body, actor, requestMeta(request.headers), {
      buildHandoff: (fileNumber, nonce) => buildAesHandoff(fileNumber, { userEmail: session.email, baseUrl, nonce }),
    });
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // e.g. the shipment couldn't be loaded. Nothing was recorded, so nothing may be sent.
    console.error("[aes-audit] hand-off request failed", err);
    return NextResponse.json(
      { error: "TMS couldn't get this ready, so nothing was sent to CBP. Please try again in a moment.", reason: "serverError" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
