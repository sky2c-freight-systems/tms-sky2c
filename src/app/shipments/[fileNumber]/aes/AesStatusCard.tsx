"use client";

import type { AesStatusLabel, AesStatusSummary } from "@/lib/aes/aesStatus";

/**
 * "CBP filing status" card on the AES page: the
 * shipment's latest known CBP status from the audit trail, plus the Check status button
 * (CBP WebLink Status API). The button is always shown; when it can't run it is disabled
 * and the reason is stated. The click handler (onCheck) is the audited hand-off in
 * AesHandoffClient — this component only presents.
 */

const LABEL: Record<AesStatusLabel, { text: string; className: string }> = {
  ACCEPTED: { text: "Accepted", className: "bg-green-100 text-green-800" },
  REJECTED: { text: "Rejected", className: "bg-red-100 text-red-800" },
  SUBMITTED: { text: "Submitted, no status yet", className: "bg-blue-100 text-blue-800" },
  FAILED: { text: "Not filed", className: "bg-red-100 text-red-800" },
  OTHER: { text: "See CBP status", className: "bg-amber-100 text-amber-800" },
  UNKNOWN: { text: "No status text", className: "bg-zinc-200 text-zinc-700" },
};

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface AesStatusCardProps {
  srn: string;
  /** Filer ID sent as FID ("" when AES_FILER_ID isn't configured). */
  filerId: string;
  summary: AesStatusSummary | null;
  /** Why the check can't run right now, or null when it can. */
  disabledReason: string | null;
  /** False when APP_BASE_URL isn't https: CBP can't send the result back to TMS. */
  returnsToTms: boolean;
  busy: boolean;
  error: string | null;
  onCheck: () => void;
}

export default function AesStatusCard({ srn, summary, disabledReason, returnsToTms, busy, error, onCheck }: AesStatusCardProps) {
  const latest = summary?.latest ?? null;
  const pending = summary?.pendingInquiry ?? null;
  const style = latest ? LABEL[latest.label] : { text: "Not checked yet", className: "bg-zinc-100 text-zinc-700" };

  return (
    <section aria-labelledby="aes-status-title" className="rounded border border-zinc-200 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="aes-status-title" className="flex flex-wrap items-center gap-2 text-base font-semibold">
            CBP filing status
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${style.className}`} data-testid="aes-status-label">{style.text}</span>
          </h2>
          <p className="text-xs text-zinc-500">
            CBP reference <span className="font-mono">{srn}</span>
          </p>

          {summary === null ? (
            <p className="text-zinc-600">Status history couldn&apos;t be loaded. You can still check with CBP.</p>
          ) : latest ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {latest.sta && (
                <li>
                  CBP says: <span className="font-medium">{latest.sta}</span>
                </li>
              )}
              {(latest.itn || summary.itn) && (
                <li>
                  ITN (export filing number): <span className="font-mono font-semibold">{latest.itn ?? summary.itn}</span>
                  {!latest.itn && summary.itn && <span className="text-xs text-zinc-500"> (from an earlier result)</span>}
                </li>
              )}
              <li className="text-xs text-zinc-500">
                {latest.source === "INQUIRY" ? "Last checked" : "Last filing"} {formatUtc(latest.returnedAt)}
                {latest.byName ? ` by ${latest.byName}` : ""}
              </li>
            </ul>
          ) : (
            <p className="text-zinc-600">No status from CBP yet.</p>
          )}

          {pending && (
            <p className={pending.noReturn ? "text-amber-800" : "text-zinc-600"}>
              {pending.noReturn
                ? "No answer from CBP after 24 hours. Check AESDirect or CBP's email."
                : `Waiting for CBP's answer (asked ${formatUtc(pending.createdAt)} by ${pending.byName}). If CBP asks, sign in on that tab.`}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onCheck}
            disabled={disabledReason !== null || busy}
            title={disabledReason ?? "Ask CBP for this shipment's latest status"}
            className="rounded border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Checking…" : "Check status with CBP"}
          </button>
          {disabledReason && <p className="max-w-xs text-right text-xs text-zinc-600">{disabledReason}</p>}
          {!disabledReason && !returnsToTms && (
            <p className="max-w-xs text-right text-xs text-zinc-600">
              CBP will show the result in its own tab.
            </p>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-right text-sm text-red-600" role="alert">{error}</p>}
    </section>
  );
}
