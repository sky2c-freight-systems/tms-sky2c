"use client";

import { useCallback, useEffect, useState } from "react";
import Spinner from "@/components/Spinner";

interface HawbRow {
  id: string;
  fileName: string;
  createdAt: string;
}

function formatWhen(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

/**
 * House Air Waybill for an Air Ops (parent) shipment: "Generate HAWB" renders a new version
 * from the shipment's current fields; every version stays listed — see src/lib/hawb.ts.
 */
export default function HawbPanel({ fileNumber }: { fileNumber: string }) {
  const [rows, setRows] = useState<HawbRow[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pdfUrl = (id: string, download = false) => `/api/shipments/${fileNumber}/hawb/${id}${download ? "?download=1" : ""}`;

  const loadRows = useCallback(async () => {
    const res = await fetch(`/api/shipments/${fileNumber}/hawb`);
    if (res.ok) setRows((await res.json()).data);
  }, [fileNumber]);

  useEffect(() => {
    // Initial load; setState happens after the await, not synchronously in the effect.
    void (async () => {
      await Promise.resolve();
      await loadRows();
    })();
  }, [loadRows]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    // Opened synchronously so the browser doesn't block it as a popup.
    const tab = window.open("", "_blank");
    try {
      const res = await fetch(`/api/shipments/${fileNumber}/hawb`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Failed to generate HAWB");
      if (tab) tab.location.href = pdfUrl(body.data.id);
      await loadRows();
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : "Failed to generate HAWB");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="mb-4 rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">House Air Waybill</h2>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {generating && <Spinner className="h-3.5 w-3.5" />}
          {generating ? "Generating..." : "Generate HAWB"}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {rows.length > 0 ? (
        <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <a href={pdfUrl(r.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400">
                {r.fileName}
              </a>
              <span className="text-xs text-zinc-500">{formatWhen(r.createdAt)}</span>
              <a href={pdfUrl(r.id, true)} className="ml-auto text-xs text-zinc-500 hover:text-blue-600 hover:underline">
                Download
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">No HAWB generated yet.</p>
      )}
    </div>
  );
}
