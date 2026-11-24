"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AES_HELP_DESK, AES_USER_GUIDE, type AesEnvironment } from "@/lib/aes/config";
import { ITN_PATTERN } from "@/lib/aes/codes";
import type { MappingRow, MappingStatus } from "@/lib/aes/weblinkFields";
import type { SubmissionView } from "@/lib/aes/audit";
import type { AesStatusSummary } from "@/lib/aes/aesStatus";
import AesStatusCard from "./AesStatusCard";

interface Props {
  fileNumber: string;
  // Used to spot changes since the page loaded.
  fieldsHash: string;
  srn: string;
  environment: AesEnvironment;
  enabled: boolean;
  configError: string | null;
  // Not shown any more; kept so props stay the same.
  configWarnings: string[];
  filingUrl: string;
  inquiryUrl: string;
  // ACE portal sign-in link.
  portalUrl: string;
  inquiry: { fields: Record<string, string>; returnsToTms: boolean } | null;
  fields: Record<string, string>;
  rows: MappingRow[];
  advisories: string[];
  counts: Record<MappingStatus, number>;
  lineCount: number;
  returnOutcome: "success" | "failure" | "status" | null;
  returnParams: Array<[string, string]>;
  // Filing this CBP return matches, or null.
  verifiedReturn: SubmissionView | null;
  // Latest CBP status, or null.
  statusSummary: AesStatusSummary | null;
  // "" if not set.
  filerId: string;
}

interface HandoffOk {
  kind: "FILING" | "INQUIRY";
  targetUrl: string;
  method: "POST" | "GET";
  fields: Record<string, string>;
  submissionId: string;
}

// Posts the saved fields to CBP in the tab we opened.
function sendToWindow(windowName: string, targetUrl: string, method: "POST" | "GET", fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = method.toLowerCase();
  form.action = targetUrl;
  form.target = windowName;
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

const POPUP_BLOCKED = "Your browser blocked the new tab, so nothing was sent. Allow pop-ups for TMS and try again.";
// Fallback error text.
const SEND_FAILED = "Couldn't save this step in TMS, so nothing was sent to CBP. Please try again in a moment.";

type FilingAction = "A" | "R";

const STATUS_STYLE: Record<MappingStatus, { label: string; className: string }> = {
  mapped: { label: "Filled from TMS", className: "bg-green-100 text-green-800" },
  derived: { label: "Please confirm", className: "bg-blue-100 text-blue-800" },
  warning: { label: "Please check", className: "bg-amber-100 text-amber-800" },
  missing: { label: "Missing in TMS", className: "bg-red-100 text-red-800" },
  "not-in-tms": { label: "Fill in AESDirect", className: "bg-zinc-200 text-zinc-700" },
};

const RETURN_TITLE = {
  success: "You're back from AESDirect",
  failure: "AESDirect sent you back without a filing",
  status: "CBP sent the latest status",
} as const;

// CBP status in plain words.
function staLabel(sta: string): string {
  const s = sta.trim().toUpperCase();
  if (s === "R" || s.includes("REJECT") || s.includes("NOT ACCEPT")) return "Rejected";
  if (s === "A" || s.includes("ACCEPT")) return "Accepted";
  return sta;
}

function param(params: Array<[string, string]>, name: string): string | undefined {
  return params.find(([k]) => k.toUpperCase() === name)?.[1];
}

export default function AesHandoffClient(props: Props) {
  const {
    fileNumber, fieldsHash, srn, environment, enabled, configError, portalUrl, inquiry,
    fields, rows, advisories, counts, lineCount, returnOutcome, returnParams, verifiedReturn, statusSummary, filerId,
  } = props;
  const router = useRouter();

  const itn = param(returnParams, "ITN");
  const sta = param(returnParams, "STA");
  const itnInUrl = !!itn && ITN_PATTERN.test(itn.trim().toUpperCase());
  // Any ITN we already have.
  const itnValid = itnInUrl || !!statusSummary?.itn;

  // Already filed, so default to Replace (CBP rejects a second Add).
  const [action, setAction] = useState<FilingAction>(itnValid ? "R" : "A");
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState(false);
  const [prodAck, setProdAck] = useState(false);
  const [busy, setBusy] = useState<"FILING" | "INQUIRY" | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [inquiryError, setInquiryError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const isCert = environment === "cert";
  const portalHost = (() => { try { return new URL(portalUrl).host; } catch { return portalUrl; } })();
  const isTestPortal = portalHost.includes(".crt.") || portalHost.startsWith("ace-test.");
  const portalLabel = isTestPortal ? "ACE test portal" : "ACE portal";
  const canFile = enabled && !configError;

  // Missing required items for the popup (sending still allowed).
  const missingRequired = useMemo(
    () => rows.filter((r) => r.required && (r.status === "missing" || r.status === "not-in-tms")).map((r) => `${groupLabel(r.group)}: ${r.label}`),
    [rows]
  );

  // Warnings for the popup.
  const confirmWarnings = useMemo(() => {
    const w: string[] = [];
    if (action === "A" && itnValid) w.push("This shipment already has an accepted filing. Choose Replace to correct it.");
    if (action === "R" && !itnValid) w.push("Replace is only for correcting an accepted filing. For a first filing, choose Add.");
    if (lineCount === 0) w.push("No goods are listed. Add them in AESDirect.");
    return w;
  }, [action, itnValid, lineCount]);

  function openConfirm() {
    if (!canFile) return;
    setProdAck(false);
    setDialogError(null);
    dialogRef.current?.showModal();
  }

  // Open the tab in the click (avoids the pop-up blocker), save the record, then post.
  // If saving fails, close the tab and send nothing.
  async function runHandoff(kind: "FILING" | "INQUIRY"): Promise<string | null> {
    const windowName = `aes-${kind.toLowerCase()}-${Date.now()}`;
    const win = window.open("", windowName);
    if (!win) return POPUP_BLOCKED;
    try {
      win.opener = null; // CBP page cannot reach back into TMS
      win.document.title = "Opening AESDirect…";
      win.document.body.textContent = "Opening CBP AESDirect…";
    } catch {
      // Cosmetic only.
    }
    try {
      const res = await fetch("/api/aes/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "FILING"
            ? { fileNumber, kind, action, expectedHash: fieldsHash, prodAcknowledged: !isCert && prodAck }
            : { fileNumber, kind, prodAcknowledged: !isCert }
        ),
      });
      const data = (await res.json().catch(() => null)) as (HandoffOk & { error?: string }) | null;
      if (!res.ok || !data || !data.targetUrl || !data.fields) {
        win.close();
        return data?.error ?? SEND_FAILED;
      }
      sendToWindow(windowName, data.targetUrl, data.method, data.fields);
      return null;
    } catch {
      win.close();
      return "Couldn't reach TMS, so nothing was sent to CBP. Check your connection and try again.";
    }
  }

  async function confirmAndSend() {
    if (!canFile || busy || (!isCert && !prodAck)) return;
    setBusy("FILING");
    setDialogError(null);
    const error = await runHandoff("FILING");
    setBusy(null);
    if (error) {
      setDialogError(error);
      return;
    }
    dialogRef.current?.close();
    setOpened(true);
    router.refresh(); // show the new audit entry
  }

  // Why status check is off (null = allowed).
  const statusDisabledReason = !enabled
    ? "AES filing is turned off. Ask your administrator."
    : configError
      ? "AES filing isn't set up correctly. Ask your administrator."
      : !inquiry
        ? "Status checks aren't set up yet. Ask your administrator."
        : busy === "FILING"
          ? "Please wait, a filing is being sent."
          : null;

  async function checkStatus() {
    if (!canFile || !inquiry || busy) return;
    if (!isCert && !window.confirm("Check this shipment's status with CBP (live)?")) return;
    setBusy("INQUIRY");
    setInquiryError(null);
    const error = await runHandoff("INQUIRY");
    setBusy(null);
    if (error) setInquiryError(error);
    else router.refresh();
  }

  const groups = useMemo(() => {
    const visible = showAll ? rows : rows.filter((r) => r.group !== "System" && (r.required || r.status !== "missing"));
    const map = new Map<string, MappingRow[]>();
    for (const r of visible) {
      if (!map.has(r.group)) map.set(r.group, []);
      map.get(r.group)!.push(r);
    }
    return [...map.entries()];
  }, [rows, showAll]);

  return (
    <div className="space-y-5">
      {/* LIVE warning (no banner in test) */}
      {!isCert && (
        <div className="rounded border border-red-400 bg-red-50 px-4 py-2 text-sm font-medium text-red-800">
          LIVE: filings go to CBP and are official export filings.
        </div>
      )}

      {/* CBP status */}
      <AesStatusCard
        srn={srn}
        filerId={filerId}
        summary={statusSummary}
        disabledReason={statusDisabledReason}
        returnsToTms={inquiry?.returnsToTms ?? false}
        busy={busy === "INQUIRY"}
        error={inquiryError}
        onCheck={checkStatus}
      />

      {/* Back from CBP */}
      {returnOutcome && (
        <div className={`rounded border px-4 py-3 text-sm ${returnOutcome === "failure" || (sta && staLabel(sta) === "Rejected") ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"}`}>
          <p className="font-medium">{RETURN_TITLE[returnOutcome]}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {sta && <li>Status: <span className="font-medium">{staLabel(sta)}</span>{staLabel(sta) !== sta ? ` (${sta})` : ""}</li>}
            {itn && (
              <li>
                ITN (export filing number): <span className="font-mono font-semibold">{itn}</span>
                {!itnInUrl && <span className="ml-1 text-red-700">— this doesn&apos;t look like a valid ITN. Don&apos;t use it.</span>}
              </li>
            )}
            {param(returnParams, "SRN") && param(returnParams, "SRN") !== srn && (
              <li className="text-red-700">This result is for a different shipment reference ({param(returnParams, "SRN")}). Check you&apos;re on the right shipment.</li>
            )}
            {!sta && !itn && <li>CBP sent no details. Check AESDirect or CBP&apos;s email.</li>}
            {verifiedReturn ? (
              <li className="text-green-800">✓ Saved in TMS (sent by {verifiedReturn.userName || verifiedReturn.userEmail}, {formatUtc(verifiedReturn.createdAt)}).</li>
            ) : (
              <li className="text-zinc-600">Unverified: not matched to a filing sent from TMS.</li>
            )}
            {itn && <li className="text-zinc-600">Check the ITN in AESDirect or CBP&apos;s email before using it on documents.</li>}
          </ul>
        </div>
      )}

      {/* Things to check */}
      {advisories.length > 0 && (
        <ul className="list-disc space-y-1 rounded border border-amber-300 bg-amber-50 px-8 py-3 text-sm text-amber-900">
          {advisories.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}

      {/* Steps to consider + user guide */}
      <div className="rounded border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">Steps to consider</p>
          <a
            href={AES_USER_GUIDE.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Opens a short guide to AES filing (PDF)"
            className="rounded border border-zinc-300 bg-white px-3 py-1 font-medium text-zinc-800 hover:bg-zinc-100"
          >
            How it works
          </a>
        </div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Use <strong>Microsoft Edge</strong>.</li>
          <li>
            Sign in to the{" "}
            <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{portalLabel}</a>
            {" "}and open <em>Accounts &gt; Exporter &gt; Submit AES Filing</em>. Keep it open.
          </li>
          <li>Choose <strong>Add</strong> (new) or <strong>Replace</strong> (correction).</li>
          <li>Click <strong>Open in AESDirect</strong>, then <strong>Confirm</strong>.</li>
          <li>In AESDirect, complete the filing and click <strong>Submit Filing</strong>.</li>
          <li>Sign-in page opens? Sign in, open <em>Submit AES Filing</em>, click Confirm again.</li>
          <li>Need help? {AES_HELP_DESK.email}, {AES_HELP_DESK.phone}.</li>
        </ul>
      </div>

      {/* Summary + actions */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(STATUS_STYLE) as MappingStatus[]).map((s) => (
            <span key={s} className={`rounded px-2 py-1 ${STATUS_STYLE[s].className}`}>
              {STATUS_STYLE[s].label}: {counts[s]}
            </span>
          ))}
          <span className="rounded bg-zinc-100 px-2 py-1 text-zinc-700">Goods lines: {lineCount}</span>
        </div>

        {/* Actions row */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <fieldset className="flex items-center gap-3 text-sm" disabled={!canFile}>
            <legend className="sr-only">Filing action</legend>
            <label className="flex items-center gap-1" title="First filing for this shipment">
              <input type="radio" name="fac" checked={action === "A"} onChange={() => setAction("A")} />
              Add (new)
            </label>
            <label className="flex items-center gap-1" title="Correct a filing CBP already accepted">
              <input type="radio" name="fac" checked={action === "R"} onChange={() => setAction("R")} />
              Replace (correction)
            </label>
          </fieldset>


          {/* Sending only happens from the popup's Confirm button */}
          <div>
            <button
              type="button"
              disabled={!canFile}
              onClick={openConfirm}
              title={configError ? "AES filing isn't set up correctly" : enabled ? undefined : "AES filing is turned off"}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              Open in AESDirect {isCert ? "(test)" : "(LIVE)"} — {action === "A" ? "Add" : "Replace"}
            </button>
          </div>
        </div>
      </div>
      {configError && <p className="text-right text-sm text-red-600">AES filing isn&apos;t set up correctly. Ask your administrator.</p>}
      {!enabled && <p className="text-right text-sm text-zinc-600">AES filing is turned off. Ask your administrator.</p>}
      {opened && (
        <ul className="list-disc space-y-0.5 rounded border border-zinc-200 px-8 py-2 text-sm text-zinc-700">
          <li>AESDirect opened in a new tab.</li>
          <li>Sign-in page instead? Sign in, open <em>Submit AES Filing</em>, then click Confirm again.</li>
        </ul>
      )}

      {/* Confirm popup */}
      <dialog
        ref={dialogRef}
        onClose={() => setProdAck(false)}
        aria-labelledby="aes-confirm-title"
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-zinc-300 p-0 shadow-xl backdrop:bg-black/40"
      >
        <div className="space-y-4 p-5 text-sm">
          <h2 id="aes-confirm-title" className="text-base font-semibold">Send this filing to CBP?</h2>

          {!isCert && (
            <div className="rounded bg-red-100 px-3 py-2 font-medium text-red-800">LIVE: this is an official export filing.</div>
          )}

          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-zinc-500">File no.</dt><dd className="font-mono">{fileNumber}</dd>
            <dt className="text-zinc-500">CBP reference</dt><dd className="font-mono">{srn}</dd>
            <dt className="text-zinc-500">Type</dt>
            <dd>{action === "A" ? "New filing (Add)" : "Correction (Replace)"}</dd>
            <dt className="text-zinc-500">Destination</dt><dd>{fields.COD || <span className="text-red-700">not set</span>}</dd>
            <dt className="text-zinc-500">Export date</dt><dd>{fields.EDA || <span className="text-red-700">not set</span>}</dd>
            <dt className="text-zinc-500">Goods lines</dt><dd>{lineCount}</dd>
            <dt className="text-zinc-500">Required items missing</dt>
            <dd>{missingRequired.length === 0 ? <span className="text-green-700">None, ready to submit</span> : missingRequired.length}{counts.warning > 0 ? `, ${counts.warning} to check` : ""}</dd>
          </dl>

          {(confirmWarnings.length > 0 || advisories.length > 0) && (
            <ul className="list-disc space-y-1 rounded bg-amber-50 px-6 py-2 text-amber-900">
              {confirmWarnings.map((w) => <li key={w}>{w}</li>)}
              {advisories.map((a) => <li key={a}>{a}</li>)}
            </ul>
          )}

          {missingRequired.length > 0 && (
            <div className="rounded bg-zinc-50 px-3 py-2 text-zinc-700">
              <p className="font-medium">Still missing (fill in AESDirect):</p>
              <ul className="mt-1 list-disc pl-5">
                {missingRequired.slice(0, 6).map((m) => <li key={m}>{m}</li>)}
                {missingRequired.length > 6 && <li>and {missingRequired.length - 6} more</li>}
              </ul>
            </div>
          )}

          <ul className="list-disc space-y-0.5 pl-5 text-zinc-600">
            <li>Stay signed in to the {portalLabel} in this browser (use Edge).</li>
            <li>AESDirect opens in a new tab with these details filled in.</li>
            <li>Nothing is filed until you click <strong>Submit Filing</strong> there.</li>
            <li>Sign-in page opens? Sign in, open <em>Submit AES Filing</em>, then click Confirm again.</li>
          </ul>

          {!isCert && (
            <label className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-red-900">
              <input type="checkbox" className="mt-0.5" checked={prodAck} onChange={(e) => setProdAck(e.target.checked)} />
              I understand this is a real filing with CBP.
            </label>
          )}

          {dialogError && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800" role="alert">{dialogError}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={busy === "FILING"} onClick={() => dialogRef.current?.close()} className="rounded border border-zinc-300 px-3 py-2 hover:bg-zinc-50 disabled:opacity-50">
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              disabled={!canFile || busy !== null || (!isCert && !prodAck)}
              onClick={confirmAndSend}
              className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "FILING" ? "Sending…" : <>Confirm &amp; open AESDirect</>}
            </button>
          </div>
        </div>
      </dialog>

      {/* Mapping table */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Details sent to AESDirect</h2>
        <label className="flex items-center gap-2 text-sm text-zinc-600">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all items
        </label>
      </div>

      <div className="overflow-x-auto rounded border border-zinc-200">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Value sent</th>
              <th className="px-3 py-2">Taken from</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, groupRows]) => (
              <GroupRows key={group} group={group} rows={groupRows} action={action} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        File {fileNumber} goes to CBP as reference {srn}. A correction (Replace) reuses the same reference.
      </p>
    </div>
  );
}

// Plain section names for the table.
function groupLabel(group: string): string {
  if (group.startsWith("USPPI")) return "Exporter";
  if (group === "Ultimate consignee") return "Consignee";
  if (group.startsWith("Forwarding agent")) return "Sky2C (filing agent)";
  if (group.startsWith("Line ")) return `Goods line ${group.slice(5)}`;
  if (group === "Commodity lines") return "Goods";
  if (group === "Equipment") return "Containers";
  return group;
}

function GroupRows({ group, rows, action }: { group: string; rows: MappingRow[]; action: FilingAction }) {
  return (
    <>
      <tr className="bg-zinc-100">
        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600">
          {groupLabel(group)}
        </td>
      </tr>
      {rows.map((r) => {
        const value = r.code === "FAC" ? action : r.value;
        return (
          <tr key={`${group}-${r.code}`} className="border-t border-zinc-100 align-top">
            <td className="px-3 py-1.5">
              {r.label}
              {r.required && <span className="ml-1 text-red-500" title="Required by CBP">*</span>}
            </td>
            <td className="px-3 py-1.5 font-mono text-xs">{value || <span className="text-zinc-400">—</span>}</td>
            <td className="px-3 py-1.5 text-xs text-zinc-600">
              {r.source}
              {r.note && <div className="text-zinc-500">{r.note}</div>}
            </td>
            <td className="px-3 py-1.5">
              <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status].className}`}>
                {STATUS_STYLE[r.status].label}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

// "2026-11-05 14:03 UTC", same on server and browser.
function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
