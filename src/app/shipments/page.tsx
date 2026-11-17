"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { DOMESTIC_TYPE_LABELS, SHIPMENT_STATUS_LABELS, toOptions } from "@/lib/enumLabels";
import { formatCents } from "@/lib/money";
import LoadingOverlay from "@/components/LoadingOverlay";

interface ShipmentRow {
  id: string;
  fileNumber: string;
  status: string;
  domesticType: string;
  origin: string | null;
  destination: string | null;
  accountName: string | null;
  totalChargesCents: number | null;
  /** Dry Run figures + totalChargesCents summed — the same grand total the invoice shows. */
  quoteAmountCents: number | null;
  shipAt: string | null;
  zohoTicketNumber: string | null;
  /** Deep link into the Zoho Desk agent console; null when the portal isn't configured. */
  zohoTicketUrl: string | null;
  invoiceCount: number;
  /** Zoho layout of the ticket behind this shipment, e.g. "Dispatch to Warehouse". */
  zohoLayoutName: string | null;
  /** Zoho "Ref Number"; null until the ticket has synced since layouts were added. */
  refNumber: string | null;
  /** Child shipments (Dispatch, Booking, ... tickets raised from this one); only on top-level rows. */
  children?: ShipmentRow[];
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "2-digit" }).format(d);
}

const PAGE_SIZE_OPTIONS = [50, 100, 150, 200];

/** Updates one row's status wherever it sits — top level or nested as a child. */
function setRowStatus(rows: ShipmentRow[], id: string, status: string): ShipmentRow[] {
  return rows.map((r) =>
    r.id === id
      ? { ...r, status }
      : r.children
        ? { ...r, children: r.children.map((c) => (c.id === id ? { ...c, status } : c)) }
        : r
  );
}

export default function ShipmentsPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [domesticType, setDomesticType] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusSavingId, setStatusSavingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
        if (q) params.set("q", q);
        if (status) params.set("status", status);
        if (domesticType) params.set("domesticType", domesticType);
        const res = await fetch(`/api/shipments?${params.toString()}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setRows(data.items);
          setTotal(data.total);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, status, domesticType, page, pageSize]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  async function handleStatusChange(row: ShipmentRow, newStatus: string) {
    const previous = row.status;
    setRows((prev) => setRowStatus(prev, row.id, newStatus));
    setStatusSavingId(row.id);
    try {
      const res = await fetch(`/api/shipments/${row.fileNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update status");
    } catch {
      // Revert on failure.
      setRows((prev) => setRowStatus(prev, row.id, previous));
    } finally {
      setStatusSavingId(null);
    }
  }

  function renderRow(
    s: ShipmentRow,
    opts: { isChild?: boolean; isLastChild?: boolean; childCount?: number; isOpen?: boolean }
  ) {
    return (
      <tr
        key={s.id}
        className={`border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50 ${
          opts.isChild ? "bg-zinc-50/60 dark:bg-zinc-900/40" : ""
        }`}
      >
        <td className={`px-3 py-2 ${opts.isChild ? "relative" : ""}`}>
          <div className="flex items-center">
            {opts.isChild ? (
              // Tree connector: a vertical line running down from the parent's arrow, with an
              // elbow into this row; the last child's line stops at its elbow.
              <>
                <span
                  aria-hidden
                  className={`absolute left-[1.375rem] top-0 w-px bg-zinc-300 dark:bg-zinc-600 ${
                    opts.isLastChild ? "h-1/2" : "h-full"
                  }`}
                />
                <span aria-hidden className="absolute left-[1.375rem] top-1/2 h-px w-4 bg-zinc-300 dark:bg-zinc-600" />
                <span className="mr-1 inline-block w-9 shrink-0" />
              </>
            ) : opts.childCount ? (
              <button
                type="button"
                onClick={() => toggleExpanded(s.id)}
                className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                title={opts.isOpen ? "Hide child shipments" : `Show ${opts.childCount} child shipment(s)`}
                aria-expanded={opts.isOpen}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className={`h-3.5 w-3.5 transition-transform ${opts.isOpen ? "rotate-90" : ""}`}>
                  <path d="M7.2 4.2a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L11.5 10 7.2 5.6a1 1 0 0 1 0-1.4Z" />
                </svg>
              </button>
            ) : (
              <span className="mr-1 inline-block w-5 shrink-0" />
            )}
            <Link href={`/shipments/${s.fileNumber}`} className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400">
              {s.fileNumber}
            </Link>
            <Link
              href={`/tracking/${s.fileNumber}`}
              target="_blank"
              className="ml-2 text-xs text-zinc-400 hover:text-blue-600 hover:underline"
              title="Open the customer tracking page"
            >
              track
            </Link>
            {s.invoiceCount > 0 && (
              <Link
                href={`/shipments/${s.fileNumber}/billing`}
                className="ml-2 inline-block rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-100 dark:bg-green-950 dark:text-green-400"
                title={`${s.invoiceCount} invoice(s) for this shipment`}
              >
                Invoices ({s.invoiceCount})
              </Link>
            )}
            {opts.isChild && s.zohoLayoutName && (
              <span className="ml-2 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                {s.zohoLayoutName}
              </span>
            )}
            {!opts.isChild && !!opts.childCount && (
              <span className="ml-2 text-[10px] text-zinc-400">{opts.childCount} child</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{s.refNumber ?? "—"}</td>
        <td className="px-3 py-2">
          <select
            className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
            value={s.status}
            disabled={statusSavingId === s.id}
            onChange={(e) => handleStatusChange(s, e.target.value)}
          >
            {toOptions(SHIPMENT_STATUS_LABELS).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-2">{DOMESTIC_TYPE_LABELS[s.domesticType] ?? s.domesticType}</td>
        <td className="px-3 py-2 text-zinc-500">{s.accountName ?? "—"}</td>
        <td className="px-3 py-2 text-zinc-500">{s.origin ?? "—"}</td>
        <td className="px-3 py-2 text-zinc-500">{s.destination ?? "—"}</td>
        <td className="px-3 py-2 text-zinc-500">
          {s.zohoTicketNumber == null ? (
            "—"
          ) : s.zohoTicketUrl ? (
            <a
              href={s.zohoTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
              title="Open this ticket in Zoho Desk"
            >
              {s.zohoTicketNumber}
            </a>
          ) : (
            s.zohoTicketNumber
          )}
        </td>
        <td className="px-3 py-2 text-right text-zinc-500">
          {s.quoteAmountCents != null ? formatCents(s.quoteAmountCents) : "—"}
        </td>
        <td className="px-3 py-2 text-zinc-500">{formatDate(s.shipAt) || "—"}</td>
      </tr>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Shipments</h1>
        <Link
          href="/shipments/new"
          className="rounded bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark dark:bg-zinc-100 dark:text-zinc-900"
        >
          + New Shipment
        </Link>
      </div>

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="w-full max-w-sm rounded border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-brand"
          placeholder="Search by file number, ref number, Zoho ticket, origin, or destination..."
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="rounded border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-brand"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {toOptions(SHIPMENT_STATUS_LABELS).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-brand"
          value={domesticType}
          onChange={(e) => {
            setDomesticType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All types</option>
          {toOptions(DOMESTIC_TYPE_LABELS).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="relative overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
        <LoadingOverlay show={loading} />
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-800">
            <tr>
              <th className="px-3 py-2 text-left font-medium">File #</th>
              <th className="px-3 py-2 text-left font-medium">Ref #</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Account</th>
              <th className="px-3 py-2 text-left font-medium">Origin</th>
              <th className="px-3 py-2 text-left font-medium">Destination</th>
              <th className="px-3 py-2 text-left font-medium">Zoho Ticket #</th>
              <th className="px-3 py-2 text-right font-medium">Quote Amount</th>
              <th className="px-3 py-2 text-left font-medium">Pickup Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const kids = s.children ?? [];
              const isOpen = expanded.has(s.id);
              return (
                <Fragment key={s.id}>
                  {renderRow(s, { childCount: kids.length, isOpen })}
                  {isOpen && kids.map((c, i) => renderRow(c, { isChild: true, isLastChild: i === kids.length - 1 }))}
                </Fragment>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-zinc-500">
                  No shipments found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{total} shipment(s)</span>
          <span className="text-zinc-300 dark:text-zinc-700">|</span>
          <label className="flex items-center gap-1.5">
            Rows per page
            <select
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-brand"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded border border-zinc-300 px-2.5 py-1 disabled:opacity-40 dark:border-zinc-700"
          >
            Previous
          </button>
          <span className="text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded border border-zinc-300 px-2.5 py-1 disabled:opacity-40 dark:border-zinc-700"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
