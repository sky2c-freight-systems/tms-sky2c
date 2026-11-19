import type { SubmissionView } from "@/lib/aes/audit";

/**
 * The shipment's latest known CBP AES status, summarised from the audit submissions the AES
 * page already loads. Pure and client-safe: only a
 * type import from audit.ts, no server code.
 *
 * CBP's WebLink Status API returns STA ("AES Status Description") and, if available, ITN to
 * the return URL. CBP doesn't publish the STA values; the legacy Sky2CWeb treated "A" as
 * accepted and "R" as rejected. decodeSta() follows that and always keeps the raw text —
 * record the real values seen on the first test run here.
 */

export type AesStatusLabel = "ACCEPTED" | "REJECTED" | "SUBMITTED" | "FAILED" | "OTHER" | "UNKNOWN";

export function decodeSta(sta: string | null | undefined): { label: AesStatusLabel; text: string } {
  const text = (sta ?? "").trim();
  const s = text.toUpperCase();
  if (!s) return { label: "UNKNOWN", text };
  if (s === "R" || s.includes("REJECT") || s.includes("NOT ACCEPT")) return { label: "REJECTED", text };
  if (s === "A" || s.startsWith("ACCEPT") || s.includes("ACCEPTED")) return { label: "ACCEPTED", text };
  return { label: "OTHER", text };
}

export interface AesStatusSummary {
  /** Most recent submission with a CBP return (filing or status check). */
  latest: null | {
    submissionId: string;
    source: "FILING" | "INQUIRY";
    outcome: "SUCCESS" | "FAILURE" | "STATUS";
    sta: string | null;
    label: AesStatusLabel;
    itn: string | null;
    returnedAt: string;
    byName: string;
  };
  /** Newest valid ITN reported for this shipment by any return (filing or status check). */
  itn: string | null;
  /** Newest status check still waiting for CBP, when newer than `latest`. */
  pendingInquiry: null | { createdAt: string; byName: string; noReturn: boolean };
  /** Newest filing hand-off, whatever its outcome. */
  lastFiling: null | { action: string | null; createdAt: string; outcome: SubmissionView["outcome"]; noReturn: boolean };
}

function byNewest<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

export function summarizeAesStatus(submissions: SubmissionView[]): AesStatusSummary {
  const returned = byNewest(
    submissions.filter((s) => s.returnedAt && s.outcome !== "PENDING"),
    (s) => s.returnedAt as string
  );
  const top = returned[0];
  let latest: AesStatusSummary["latest"] = null;
  if (top) {
    const outcome = top.outcome as "SUCCESS" | "FAILURE" | "STATUS";
    let label = decodeSta(top.staReported).label;
    if (label === "UNKNOWN") {
      // No STA: a filing return still tells us which return URL CBP used.
      if (outcome === "FAILURE") label = "FAILED";
      else if (outcome === "SUCCESS") label = top.itnReported ? "ACCEPTED" : "SUBMITTED";
    }
    latest = {
      submissionId: top.id,
      source: top.kind,
      outcome,
      sta: top.staReported,
      label,
      itn: top.itnReported,
      returnedAt: top.returnedAt as string,
      byName: top.userName || top.userEmail,
    };
  }

  const withItn = returned.find((s) => s.itnReported);
  const inquiries = byNewest(submissions.filter((s) => s.kind === "INQUIRY" && s.outcome === "PENDING"), (s) => s.createdAt);
  const pending = inquiries[0];
  const filings = byNewest(submissions.filter((s) => s.kind === "FILING"), (s) => s.createdAt);
  const filing = filings[0];

  return {
    latest,
    itn: withItn?.itnReported ?? null,
    pendingInquiry:
      pending && (!latest || pending.createdAt > latest.returnedAt)
        ? { createdAt: pending.createdAt, byName: pending.userName || pending.userEmail, noReturn: pending.noReturn }
        : null,
    lastFiling: filing ? { action: filing.action, createdAt: filing.createdAt, outcome: filing.outcome, noReturn: filing.noReturn } : null,
  };
}

export const EMPTY_STATUS_SUMMARY: AesStatusSummary = { latest: null, itn: null, pendingInquiry: null, lastFiling: null };
