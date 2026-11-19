import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { generateHawb, isAirOpsShipment, listHawbs } from "@/lib/hawb";

interface RouteParams {
  params: Promise<{ fileNumber: string }>;
}

/** GET /api/shipments/[fileNumber]/hawb — the shipment's generated HAWBs, newest first. */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const { fileNumber } = await params;
  const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber }, select: { id: true } });
  if (!shipment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data: await listHawbs(shipment.id) });
}

/** POST /api/shipments/[fileNumber]/hawb — "Generate HAWB": renders and saves a new version. */
export async function POST(_request: Request, { params }: RouteParams) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  const { fileNumber } = await params;
  const shipment = await prisma.domesticWarehouseShipment.findUnique({ where: { fileNumber } });
  if (!shipment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAirOpsShipment(shipment)) {
    return NextResponse.json({ error: "HAWB generation is only for Air Ops shipments" }, { status: 400 });
  }
  try {
    const doc = await generateHawb(shipment, session.displayName ?? session.email ?? null, session.userId);
    return NextResponse.json({ data: doc }, { status: 201 });
  } catch (err) {
    console.error(`[hawb] generation failed for ${fileNumber}:`, err);
    return NextResponse.json({ error: "Failed to generate HAWB" }, { status: 500 });
  }
}
