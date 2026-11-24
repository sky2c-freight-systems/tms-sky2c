"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CONSIGNEE_TYPES,
  EMPTY_AES_LINE,
  MOT_OPTIONS,
  ORIGIN_TYPES,
  PARTY_ID_TYPES,
  VEHICLE_ID_TYPES,
  type AesDetails,
  type AesLineDetails,
} from "@/lib/aes/aesDetails";

// AES details form: info TMS doesn't hold. Keep the wording plain (no AES codes).

export interface AesDetailsFormProps {
  fileNumber: string;
  initial: AesDetails;
  lines: Array<{ key: string; description: string; vehicle: boolean; tmsValue?: string; tmsWeightKg?: string }>;
  // Current TMS values, shown as hints.
  tmsValues: { mot: string; portOfExport: string; portOfUnlading: string; transportRef: string; conveyanceName: string; exporterId?: string };
  updatedAt: string | null;
  updatedByName: string | null;
  // Required items still missing.
  missingRequired: number;
}

type TopKey = Exclude<keyof AesDetails, "lines">;

const YN: Array<[string, string]> = [["N", "No"], ["Y", "Yes"]];

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export default function AesDetailsForm(props: AesDetailsFormProps) {
  const { fileNumber, lines, tmsValues, updatedAt, updatedByName, missingRequired } = props;
  const router = useRouter();
  const [data, setData] = useState<AesDetails>(() => ({
    ...props.initial,
    lines: Object.fromEntries(lines.map((l) => [l.key, { ...EMPTY_AES_LINE, ...(props.initial.lines[l.key] ?? {}) }])),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const setTop = (k: TopKey, v: string) => {
    setData((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const setLine = (key: string, k: keyof AesLineDetails, v: string) => {
    setData((d) => ({ ...d, lines: { ...d.lines, [key]: { ...(d.lines[key] ?? EMPTY_AES_LINE), [k]: v } } }));
    setDirty(true);
  };

  // Fills empty boxes only.
  function fillUsual() {
    setData((d) => {
      const next = { ...d, lines: { ...d.lines } };
      for (const l of lines) {
        const cur = { ...(next.lines[l.key] ?? EMPTY_AES_LINE) };
        if (!cur.exportInfoCode) cur.exportInfoCode = "OS";
        if (!cur.licenseType) cur.licenseType = "C33";
        if (!cur.origin) cur.origin = "D";
        if (!cur.epaRequired) cur.epaRequired = "N";
        if (!cur.amsRequired) cur.amsRequired = "N";
        if (l.vehicle && !cur.vehicleIdType) cur.vehicleIdType = "V";
        next.lines[l.key] = cur;
      }
      for (const k of ["relatedParties", "hazardous", "routedExport", "soldEnRoute"] as const) if (!next[k]) next[k] = "N";
      if (!next.filingOption) next.filingOption = "2";
      return next;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setErrors({});
    try {
      const res = await fetch("/api/aes/details", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileNumber, details: data }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; fieldErrors?: Record<string, string> } | null;
      if (!res.ok) {
        setErrors(body?.fieldErrors ?? {});
        setMessage({ kind: "error", text: body?.error ?? "Couldn't save the AES details. Please try again in a moment." });
        return;
      }
      setDirty(false);
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh(); // reload with the new values
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach TMS. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  }

  const err = (k: string) => errors[k];
  const errorCount = useMemo(() => Object.keys(errors).length, [errors]);

  return (
    <details className="rounded border border-zinc-200" open={missingRequired > 0}>
      <summary className="cursor-pointer select-none px-4 py-3">
        <span className="text-base font-semibold">AES details</span>
        <span className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${missingRequired > 0 ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}>
          {missingRequired > 0 ? `${missingRequired} required item${missingRequired === 1 ? "" : "s"} missing` : "All required items filled"}
        </span>
        {updatedAt && <span className="ml-2 text-xs text-zinc-500">Last saved {formatUtc(updatedAt)}{updatedByName ? ` by ${updatedByName}` : ""}</span>}
      </summary>

      <div className="space-y-5 px-4 pb-4 text-sm">
        <ul className="list-disc pl-5 text-zinc-600">
          <li>Fill in what TMS doesn&apos;t hold. Saved for this shipment and sent to AESDirect.</li>
          <li>Leave a box empty to use what TMS already has (shown as &quot;From TMS&quot;).</li>
        </ul>

        <Section title="Shipment">
          <Select label="Filing option" value={data.filingOption} onChange={(v) => setTop("filingOption", v)} options={[["2", "Before departure"], ["4", "After departure (CBP-approved only)"]]} error={err("filingOption")} />
          <Select label="Mode of transport" value={data.modeOfTransport} onChange={(v) => setTop("modeOfTransport", v)} options={MOT_OPTIONS} hint={tmsValues.mot ? `From TMS: ${MOT_OPTIONS.find(([c]) => c === tmsValues.mot)?.[1] ?? tmsValues.mot}` : undefined} error={err("modeOfTransport")} />
          <Input label="US port of export (4 digits)" value={data.portOfExport} onChange={(v) => setTop("portOfExport", v)} tms={tmsValues.portOfExport} error={err("portOfExport")} />
          <Input label="Port of unloading (4–5 digits)" value={data.portOfUnlading} onChange={(v) => setTop("portOfUnlading", v)} tms={tmsValues.portOfUnlading} error={err("portOfUnlading")} />
          <Input label="Export carrier booking / AWB / BOL" value={data.transportRef} onChange={(v) => setTop("transportRef", v)} tms={tmsValues.transportRef} error={err("transportRef")} />
          <Input label="Carrier code (SCAC, or IATA for air)" value={data.carrierCode} onChange={(v) => setTop("carrierCode", v)} required error={err("carrierCode")} />
          <Input label="Export carrier / vessel name" value={data.conveyanceName} onChange={(v) => setTop("conveyanceName", v)} tms={tmsValues.conveyanceName} required error={err("conveyanceName")} />
          <Select label="Exporter and consignee related?" value={data.relatedParties} onChange={(v) => setTop("relatedParties", v)} options={YN} required error={err("relatedParties")} />
          <Select label="Hazardous goods? (default No)" value={data.hazardous} onChange={(v) => setTop("hazardous", v)} options={YN} error={err("hazardous")} />
          <Select label="Routed export? (default No)" value={data.routedExport} onChange={(v) => setTop("routedExport", v)} options={YN} error={err("routedExport")} />
          <Input label="In-bond code (default 70 = not in bond)" value={data.inbondCode} onChange={(v) => setTop("inbondCode", v)} placeholder="70" error={err("inbondCode")} />
          <Input label="In-bond entry number" value={data.entryNumber} onChange={(v) => setTop("entryNumber", v)} error={err("entryNumber")} />
          <Input label="Foreign trade zone number" value={data.ftzNumber} onChange={(v) => setTop("ftzNumber", v)} error={err("ftzNumber")} />
          <Input label="Original ITN (if replacing a split shipment)" value={data.originalItn} onChange={(v) => setTop("originalItn", v)} error={err("originalItn")} />
        </Section>

        <Section title="Exporter">
          <Input label="Exporter EIN (empty = use the Account's)" value={data.exporterIdNumber} onChange={(v) => setTop("exporterIdNumber", v)} tms={tmsValues.exporterId} error={err("exporterIdNumber")} />
          <Select label="ID type" value={data.exporterIdType} onChange={(v) => setTop("exporterIdType", v)} options={PARTY_ID_TYPES} error={err("exporterIdType")} />
        </Section>

        <Section title="Consignee">
          <Select label="Consignee type" value={data.consigneeType} onChange={(v) => setTop("consigneeType", v)} options={CONSIGNEE_TYPES} required error={err("consigneeType")} />
          <Select label="Sold while in transit?" value={data.soldEnRoute} onChange={(v) => setTop("soldEnRoute", v)} options={YN} error={err("soldEnRoute")} />
        </Section>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Goods lines</p>
            {lines.length > 0 && (
              <button type="button" onClick={fillUsual} className="rounded border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-50">
                Fill usual values (OS, C33, made in US, no EPA/AMS)
              </button>
            )}
          </div>
          {lines.length === 0 && <p className="text-zinc-600">No goods lines in TMS. Add cargo items to the shipment first.</p>}
          {lines.map((l, i) => {
            const ld = data.lines[l.key] ?? EMPTY_AES_LINE;
            const e = (k: keyof AesLineDetails) => err(`lines.${l.key}.${k}`);
            return (
              <div key={l.key} className="rounded border border-zinc-200 px-3 py-2">
                <p className="mb-2 font-medium">Line {i + 1}: <span className="font-normal text-zinc-700">{l.description}</span></p>
                <div className="grid gap-3 md:grid-cols-4">
                  <Input label="Schedule B number (10 digits)" value={ld.scheduleB} onChange={(v) => setLine(l.key, "scheduleB", v)} required error={e("scheduleB")} />
                  <Input label="Export info code (OS; HH = household goods only)" value={ld.exportInfoCode} onChange={(v) => setLine(l.key, "exportInfoCode", v)} placeholder="OS" error={e("exportInfoCode")} />
                  <Input label="License type" value={ld.licenseType} onChange={(v) => setLine(l.key, "licenseType", v)} placeholder="C33" required error={e("licenseType")} />
                  <Select label="Origin of goods" value={ld.origin} onChange={(v) => setLine(l.key, "origin", v)} options={ORIGIN_TYPES} required error={e("origin")} />
                  <Input label="Value of goods (USD)" value={ld.valueUsd} onChange={(v) => setLine(l.key, "valueUsd", v)} tms={l.tmsValue} required error={e("valueUsd")} />
                  <Input label="Shipping weight (kg)" value={ld.weightKg} onChange={(v) => setLine(l.key, "weightKg", v)} tms={l.tmsWeightKg} required error={e("weightKg")} />
                  <Input label="Quantity (Schedule B unit)" value={ld.quantity1} onChange={(v) => setLine(l.key, "quantity1", v)} error={e("quantity1")} />
                  <Input label="Unit (e.g. KG, NO, X)" value={ld.unit1} onChange={(v) => setLine(l.key, "unit1", v)} error={e("unit1")} />
                  <Input label="Second quantity" value={ld.quantity2} onChange={(v) => setLine(l.key, "quantity2", v)} error={e("quantity2")} />
                  <Input label="Second unit" value={ld.unit2} onChange={(v) => setLine(l.key, "unit2", v)} error={e("unit2")} />
                  <Input label="License number" value={ld.licenseNumber} onChange={(v) => setLine(l.key, "licenseNumber", v)} error={e("licenseNumber")} />
                  <Input label="License value (USD)" value={ld.licenseValue} onChange={(v) => setLine(l.key, "licenseValue", v)} error={e("licenseValue")} />
                  <Input label="ECCN (e.g. EAR99)" value={ld.eccn} onChange={(v) => setLine(l.key, "eccn", v)} error={e("eccn")} />
                  <Select label="EPA data needed?" value={ld.epaRequired} onChange={(v) => setLine(l.key, "epaRequired", v)} options={YN} error={e("epaRequired")} />
                  <Select label="USDA AMS data needed?" value={ld.amsRequired} onChange={(v) => setLine(l.key, "amsRequired", v)} options={YN} error={e("amsRequired")} />
                  {l.vehicle && (
                    <>
                      <Select label="Vehicle ID type" value={ld.vehicleIdType} onChange={(v) => setLine(l.key, "vehicleIdType", v)} options={VEHICLE_ID_TYPES} error={e("vehicleIdType")} />
                      <Input label="VIN / product ID" value={ld.vin} onChange={(v) => setLine(l.key, "vin", v)} required error={e("vin")} />
                    </>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-zinc-600">State Department (ITAR) items — only for licensed defense goods</summary>
                  <div className="mt-2 grid gap-3 md:grid-cols-4">
                    <Input label="ITAR exemption number" value={ld.ddtcItarExemption} onChange={(v) => setLine(l.key, "ddtcItarExemption", v)} error={e("ddtcItarExemption")} />
                    <Input label="Registration number" value={ld.ddtcRegistration} onChange={(v) => setLine(l.key, "ddtcRegistration", v)} error={e("ddtcRegistration")} />
                    <Select label="Significant military equipment?" value={ld.ddtcSignificantMilitary} onChange={(v) => setLine(l.key, "ddtcSignificantMilitary", v)} options={YN} error={e("ddtcSignificantMilitary")} />
                    <Select label="Eligible party certified?" value={ld.ddtcEligibleParty} onChange={(v) => setLine(l.key, "ddtcEligibleParty", v)} options={YN} error={e("ddtcEligibleParty")} />
                    <Input label="USML category" value={ld.ddtcUsmlCategory} onChange={(v) => setLine(l.key, "ddtcUsmlCategory", v)} error={e("ddtcUsmlCategory")} />
                    <Input label="Quantity" value={ld.ddtcQuantity} onChange={(v) => setLine(l.key, "ddtcQuantity", v)} error={e("ddtcQuantity")} />
                    <Input label="Unit" value={ld.ddtcUnit} onChange={(v) => setLine(l.key, "ddtcUnit", v)} error={e("ddtcUnit")} />
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {message && (
            <span role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-red-600" : "text-green-700"}>
              {message.text}{message.kind === "error" && errorCount > 0 ? ` (${errorCount})` : ""}
            </span>
          )}
          {dirty && !saving && <span className="text-xs text-zinc-500">Unsaved changes</span>}
          <button type="button" onClick={save} disabled={saving} className="rounded bg-brand px-4 py-2 font-medium text-white hover:bg-brand-dark disabled:opacity-50">
            {saving ? "Saving…" : "Save AES details"}
          </button>
        </div>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 font-semibold">{title}</p>
      <div className="grid gap-3 md:grid-cols-4">{children}</div>
    </div>
  );
}

// tms = the value TMS sends when this box is left empty.
function Input(p: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; tms?: string; required?: boolean; error?: string }) {
  const fromTms = !p.value && !!p.tms;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-600">{p.label}{p.required && !fromTms && <span className="ml-0.5 text-red-500" title="Required">*</span>}</span>
      <input
        value={p.value}
        placeholder={p.tms || p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        aria-invalid={!!p.error}
        className={`rounded border px-2 py-1.5 ${p.error ? "border-red-400" : "border-zinc-300"}`}
      />
      {fromTms && <span className="text-xs text-green-700">From TMS: {p.tms}</span>}
      {p.error && <span className="text-xs text-red-600">{p.error}</span>}
    </label>
  );
}

function Select(p: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>; hint?: string; required?: boolean; error?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-600">{p.label}{p.required && <span className="ml-0.5 text-red-500" title="Required">*</span>}</span>
      <select value={p.value} onChange={(e) => p.onChange(e.target.value)} aria-invalid={!!p.error} className={`rounded border px-2 py-1.5 ${p.error ? "border-red-400" : "border-zinc-300"}`}>
        <option value="">{p.hint ?? "—"}</option>
        {p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {p.error && <span className="text-xs text-red-600">{p.error}</span>}
    </label>
  );
}
