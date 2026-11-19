import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { getAesConfig } from "@/lib/aes/config";
import { requestMeta } from "@/lib/aes/audit";
import { validateAesDetails } from "@/lib/aes/aesDetails";
import { saveAesDetails } from "@/lib/aes/aesDetailsStore";

// PUT /api/aes/details - saves the AES details form (staff only).
const FILE_NUMBER = /^[A-Za-z0-9-]{1,30}$/;
const MAX_LINE_KEYS = 120;

export async function PUT(request: Request) {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Expected application/json." }, { status: 415 });
  }
  let body: { fileNumber?: unknown; details?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Something went wrong. Reload the page and try again." }, { status: 400 });
  }
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ error: "Your session has expired — sign in again." }, { status: 401 });

  const fileNumber = typeof body?.fileNumber === "string" ? body.fileNumber.trim() : "";
  if (!FILE_NUMBER.test(fileNumber)) return NextResponse.json({ error: "Something went wrong. Reload the page and try again." }, { status: 400 });

  const lines = (body?.details as { lines?: unknown } | undefined)?.lines;
  if (lines && typeof lines === "object" && Object.keys(lines).length > MAX_LINE_KEYS) {
    return NextResponse.json({ error: "Too many goods lines." }, { status: 400 });
  }
  const checked = validateAesDetails(body?.details ?? {});
  if (!checked.ok) {
    return NextResponse.json({ error: "Please fix the highlighted items.", fieldErrors: checked.errors }, { status: 400 });
  }

  try {
    const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber }, select: { id: true } });
    if (!shipment) return NextResponse.json({ error: `Shipment ${fileNumber} not found.` }, { status: 404 });
    const { changed } = await saveAesDetails({
      shipmentId: shipment.id,
      fileNumber,
      environment: getAesConfig().environment,
      details: checked.details,
      actor: { userId: session.userId, email: session.email ?? "", name: session.displayName ?? session.email ?? "" },
      meta: requestMeta(request.headers),
    });
    return NextResponse.json({ ok: true, changed: changed.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[aes-details] save failed", fileNumber, err);
    return NextResponse.json({ error: "Couldn't save the AES details. Please try again in a moment." }, { status: 503 });
  }
}
