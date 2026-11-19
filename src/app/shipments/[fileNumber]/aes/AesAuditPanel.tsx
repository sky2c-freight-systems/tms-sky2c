"use client";

import { Fragment, useMemo, useState } from "react";
import type { EventView, SubmissionView } from "@/lib/aes/audit";
import { diffPayloads, type FieldDiffRow } from "@/lib/aes/auditDiff";

// AES audit history for a shipment, newest first. Read-only.

const TYPE_LABEL: Record<string, { label: string; className: string }> = {
  FILING_HANDOFF: { label: "Filing sent", className: "bg-blue-100 text-blue-800" },
  INQUIRY_HANDOFF: { label: "Status inquiry", className: "bg-sky-100 text-sky-800" },
  HANDOFF_BLOCKED: { label: "Blocked", className: "bg-zinc-200 text-zinc-700" },
  HANDOFF_STALE: { label: "Stale page", className: "bg-amber-100 text-amber-800" },
  CBP_RETURN: { label: "CBP return", className: "bg-green-100 text-green-800" },
  CBP_RETURN_REPEAT: { label: "CBP return (repeat)", className: "bg-green-50 text-green-700" },
  DETAILS_SAVED: { label: "AES details saved", className: "bg-zinc-100 text-zinc-700" },
  ITN_CONFIRMED: { label: "ITN confirmed", className: "bg-green-100 text-green-800" },
  ITN_ENTERED_MANUALLY: { label: "ITN entered", className: "bg-green-100 text-green-800" },
  MARKED_EXEMPT: { label: "Marked exempt", className: "bg-zinc-200 text-zinc-700" },
};

const OUTCOME_LABEL: Record<string, string> = {
  PENDING: "Waiting for CBP",
  SUCCESS: "CBP success",
  FAILURE: "CBP failure",
  STATUS: "Status returned",
};

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export default function AesAuditPanel({ audit }: { audit: { submissions: SubmissionView[]; events: EventView[] } | null }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const submissionsById = useMemo(() => new Map((audit?.submissions ?? []).map((s) => [s.id, s])), [audit]);
  // Previous filing, for the diff.
  const previousFiling = useMemo(() => {
    const filings = (audit?.submissions ?? []).filter((s) => s.kind === "FILING");
    const map = new Map<string, SubmissionView | null>();
    filings.forEach((s, i) => map.set(s.id, filings[i + 1] ?? null));
    return map;
  }, [audit]);

  if (!audit) {
    return (
      <section className="rounded border border-zinc-200 p-4 text-sm text-zinc-600">
        <h2 className="text-base font-semibold text-zinc-900">AES audit history</h2>
        <p className="mt-1">The audit history couldn&apos;t be loaded right now. Hand-offs are still recorded; reload to try again.</p>
      </section>
    );
  }

  const { events, submissions } = audit;
  const pending = submissions.filter((s) => s.noReturn);

  return (
    <details className="rounded border border-zinc-200" open={events.length > 0 && events.length <= 5}>
      <summary className="cursor-pointer select-none px-4 py-3 text-base font-semibold">
        AES audit history{" "}
        <span className="ml-1 rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">{events.length}</span>
      </summary>
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs text-zinc-500">
          Every hand-off to CBP and every CBP return for this shipment, newest first. Times are UTC. Entries can&apos;t be edited or deleted.
        </p>
        {pending.length > 0 && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {pending.length} hand-off{pending.length === 1 ? "" : "s"} with no return from CBP after 24 hours — check AESDirect or the CBP email for the result.
          </p>
        )}
        {events.length === 0 ? (
          <p className="text-sm text-zinc-600">Nothing recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-3 py-2">When (UTC)</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Who</th>
                  <th className="px-3 py-2">Env</th>
                  <th className="px-3 py-2">Details</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const sub = e.submissionId ? submissionsById.get(e.submissionId) : undefined;
                  const style = TYPE_LABEL[e.type] ?? { label: e.type, className: "bg-zinc-100 text-zinc-700" };
                  const expandable = !!sub && (e.type === "FILING_HANDOFF" || e.type === "INQUIRY_HANDOFF");
                  const isOpen = openId === e.id;
                  return (
                    <Fragment key={e.id}>
                      <tr className="border-t border-zinc-100 align-top">
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{formatUtc(e.createdAt)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${style.className}`}>{style.label}</span>
                        </td>
                        <td className="px-3 py-1.5 text-xs">{e.actorType === "CBP" ? "CBP (return)" : e.userName || e.userEmail || "—"}</td>
                        <td className="px-3 py-1.5 text-xs">{e.environment === "cert" ? "staging" : <span className="font-semibold text-red-700">production</span>}</td>
                        <td className="px-3 py-1.5 text-xs text-zinc-700">
                          {e.summary}
                          {expandable && (
                            <button type="button" onClick={() => setOpenId(isOpen ? null : e.id)} className="ml-2 text-blue-600 hover:underline">
                              {isOpen ? "Hide fields" : "Show fields"}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs">
                          {sub && (e.type === "FILING_HANDOFF" || e.type === "INQUIRY_HANDOFF") ? (
                            <>
                              {sub.noReturn ? <span className="text-amber-700">No return after 24 h</span> : OUTCOME_LABEL[sub.outcome] ?? sub.outcome}
                              {sub.itnReported && <div className="font-mono">ITN {sub.itnReported}</div>}
                            </>
                          ) : (
                            <ReturnChecks detail={e.detail} />
                          )}
                        </td>
                      </tr>
                      {expandable && isOpen && sub && (
                        <tr className="border-t border-zinc-100 bg-zinc-50">
                          <td colSpan={6} className="px-3 py-2">
                            <PayloadView sub={sub} previous={sub.kind === "FILING" ? previousFiling.get(sub.id) ?? null : null} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

function ReturnChecks({ detail }: { detail: unknown }) {
  const checks = (detail as { checks?: Record<string, unknown> } | null)?.checks;
  if (!checks) return null;
  const notes: string[] = [];
  if (checks.srnMatches === false) notes.push(`SRN mismatch (${String(checks.srnReturned)})`);
  if (checks.itnFormatOk === false) notes.push("ITN format invalid — not recorded");
  if (checks.sta) notes.push(`STA ${String(checks.sta)}`);
  return notes.length ? <span className={checks.srnMatches === false || checks.itnFormatOk === false ? "text-red-700" : ""}>{notes.join(" · ")}</span> : null;
}

const CHANGE_STYLE: Record<FieldDiffRow["change"], string> = {
  added: "text-green-700",
  removed: "text-red-700 line-through",
  changed: "text-amber-800",
  same: "text-zinc-600",
};

function PayloadView({ sub, previous }: { sub: SubmissionView; previous: SubmissionView | null }) {
  const [showAll, setShowAll] = useState(!previous);
  const rows = diffPayloads(previous ? previous.payload : null, sub.payload, { includeSame: showAll });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-600">
        <span>SRN <span className="font-mono">{sub.srn}</span></span>
        {sub.action && <span>Action {sub.action === "R" ? "Replace" : "Add"}</span>}
        <span>Lines {sub.lineCount}</span>
        <span className="break-all">To {sub.targetUrl}</span>
        <span className="font-mono" title="sha256 of the fields (without return URLs / FAC)">hash {sub.payloadHash.slice(0, 12)}…</span>
        {previous && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showAll} onChange={(ev) => setShowAll(ev.target.checked)} />
            Show unchanged fields
          </label>
        )}
      </div>
      {previous && !showAll && rows.length === 0 && <p className="text-zinc-600">Same fields as the previous filing ({formatUtc(previous.createdAt)}).</p>}
      {previous && !showAll && rows.length > 0 && <p className="text-zinc-600">Changes since the previous filing ({formatUtc(previous.createdAt)}):</p>}
      {rows.length > 0 && (
        <table className="min-w-full">
          <thead className="text-left uppercase text-zinc-500">
            <tr>
              <th className="py-1 pr-3">Field</th>
              {previous && <th className="py-1 pr-3">Previous</th>}
              <th className="py-1 pr-3">Sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-200">
                <td className="py-0.5 pr-3 font-mono">{r.name}</td>
                {previous && <td className="py-0.5 pr-3 font-mono text-zinc-500">{r.before ?? "—"}</td>}
                <td className={`py-0.5 pr-3 font-mono ${previous ? CHANGE_STYLE[r.change] : ""}`}>{r.after ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
