import Link from "next/link";
import { AUDIT_EVENT_TYPES, AUDIT_PAGE_SIZE, listAuditEvents, parseAuditFilters, type EventView } from "@/lib/aes/audit";

// Live audit trail: never prerender or cache (see the same note on /zoho-sync).
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** Staff-wide, read-only list of AES / CBP audit events with filters and CSV export. */
export default async function AesAuditPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const filters = parseAuditFilters(query);
  const page = Math.max(1, Number.parseInt(one(query.page), 10) || 1);

  let events: EventView[] = [];
  let total = 0;
  let loadError = false;
  try {
    ({ events, total } = await listAuditEvents(filters, page));
  } catch (err) {
    console.error("[aes-audit] could not load audit events", err);
    loadError = true;
  }

  // Filter values echoed back into the form / links (only the validated ones).
  const kept = new URLSearchParams();
  for (const k of ["fileNumber", "type", "environment", "user", "from", "to"]) {
    const v = one(query[k]).trim();
    if (v) kept.set(k, v);
  }
  const pageHref = (p: number) => {
    const q = new URLSearchParams(kept);
    q.set("page", String(p));
    return `/aes-audit?${q.toString()}`;
  };
  const csv = new URLSearchParams(kept);
  csv.set("format", "csv");
  const lastPage = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">AES Audit</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every hand-off from TMS to CBP AESDirect WebLink and every CBP return, newest first. Times are UTC. Read-only.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">File #</span>
          <input name="fileNumber" defaultValue={one(query.fileNumber)} className="w-32 rounded border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Event</span>
          <select name="type" defaultValue={one(query.type)} className="rounded border border-slate-300 px-2 py-1">
            <option value="">All</option>
            {AUDIT_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Environment</span>
          <select name="environment" defaultValue={one(query.environment)} className="rounded border border-slate-300 px-2 py-1">
            <option value="">All</option>
            <option value="cert">Staging (cert)</option>
            <option value="production">Production</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">User email</span>
          <input name="user" defaultValue={one(query.user)} className="w-48 rounded border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">From (UTC)</span>
          <input type="date" name="from" defaultValue={one(query.from)} className="rounded border border-slate-300 px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">To (UTC)</span>
          <input type="date" name="to" defaultValue={one(query.to)} className="rounded border border-slate-300 px-2 py-1" />
        </label>
        <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 text-white hover:bg-slate-700">Filter</button>
        <Link href="/aes-audit" className="px-1 py-1.5 text-slate-600 hover:underline">Clear</Link>
        <a href={`/api/aes/audit?${csv.toString()}`} className="ml-auto rounded border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
          Export CSV
        </a>
      </form>

      {loadError ? (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">The audit log couldn&apos;t be loaded. Try again in a moment.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">When (UTC)</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Event</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">File #</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Env</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Who</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-500">No AES audit events match.</td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700">{formatUtc(e.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-700">{e.type}</td>
                  <td className="px-3 py-2">
                    <Link href={`/shipments/${encodeURIComponent(e.fileNumber)}/aes`} className="text-blue-600 hover:underline">{e.fileNumber}</Link>
                  </td>
                  <td className="px-3 py-2 text-xs">{e.environment === "cert" ? "staging" : <span className="font-semibold text-red-700">production</span>}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{e.actorType === "CBP" ? "CBP (return)" : e.userName || e.userEmail || "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loadError && total > AUDIT_PAGE_SIZE && (
        <div className="flex items-center justify-end gap-3 text-sm text-slate-600">
          <span>Page {page} of {lastPage} ({total} events)</span>
          {page > 1 && <Link href={pageHref(page - 1)} className="text-blue-600 hover:underline">← Newer</Link>}
          {page < lastPage && <Link href={pageHref(page + 1)} className="text-blue-600 hover:underline">Older →</Link>}
        </div>
      )}
    </div>
  );
}
