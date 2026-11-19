import { NextResponse } from "next/server";
import { eventsToCsv, listAuditEventsForCsv, parseAuditFilters } from "@/lib/aes/audit";

/**
 * GET /api/aes/audit?format=csv&fileNumber=&type=&environment=&user=&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Staff only (middleware). Read-only CSV export of the AES audit events matching the same
 * filters as the /aes-audit page (newest first, capped at AUDIT_CSV_MAX_ROWS).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (query.format !== "csv") return NextResponse.json({ error: "Only format=csv is supported." }, { status: 400 });

  let events;
  try {
    events = await listAuditEventsForCsv(parseAuditFilters(query));
  } catch (err) {
    console.error("[aes-audit] CSV export failed", err);
    return NextResponse.json({ error: "The audit log couldn't be loaded. Try again in a moment." }, { status: 503 });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(eventsToCsv(events), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="aes-audit-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
