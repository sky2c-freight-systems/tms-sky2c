/**
 * Field-level diff between two AES payloads (what was posted to CBP), for the audit
 * history on the AES page — mostly useful to see what a Replace changed. Pure and
 * client-safe (no server imports).
 */

export type FieldChange = "added" | "removed" | "changed" | "same";

export interface FieldDiffRow {
  name: string;
  before: string | null;
  after: string | null;
  change: FieldChange;
}

/** Fields that differ on every hand-off by design (per-hand-off return addresses). */
const IGNORED = new Set(["wl_success_url", "wl_nosed_url", "URL"]);

/** Sort key that keeps WebLink's numbered groups in order: AD0_1, AD0_2, …, IT1_1, IT1_10, IT2_1. */
function sortKey(name: string): string {
  return name.replace(/\d+/g, (d) => d.padStart(4, "0"));
}

export function diffPayloads(
  before: Record<string, string> | null,
  after: Record<string, string>,
  opts: { includeSame?: boolean } = {}
): FieldDiffRow[] {
  const prev = before ?? {};
  const names = new Set([...Object.keys(prev), ...Object.keys(after)]);
  const rows: FieldDiffRow[] = [];
  for (const name of names) {
    if (IGNORED.has(name)) continue;
    const b = name in prev ? prev[name] : null;
    const a = name in after ? after[name] : null;
    const change: FieldChange = b === null ? "added" : a === null ? "removed" : a === b ? "same" : "changed";
    if (change === "same" && !opts.includeSame) continue;
    rows.push({ name, before: b, after: a, change });
  }
  return rows.sort((x, y) => sortKey(x.name).localeCompare(sortKey(y.name)));
}
