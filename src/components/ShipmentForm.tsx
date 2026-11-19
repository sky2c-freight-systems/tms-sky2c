"use client";

import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ClientLookupField from "@/components/ClientLookupField";
import LocationLookupField from "@/components/LocationLookupField";
import {
  DOMESTIC_TYPE_LABELS,
  INCOTERMS_LABELS,
  TYPE_OF_SERVICE_LABELS,
  PAYMENT_METHOD_LABELS,
  SHIPMENT_STATUS_LABELS,
  toOptions,
} from "@/lib/enumLabels";
import {
  ZOHO_SECTIONS,
  emptyExtraFieldValues,
  extraFieldsToBody,
  extraFieldsToFormValues,
  type ExistingSectionFieldKey,
  type ExtraFieldDef,
  type ExtraFieldFormValues,
  type ExtraFieldKey,
} from "@/lib/shipmentZohoSections";
import { getLayout, layoutsForShipment, type LayoutField } from "@/lib/zohoLayouts";
import {
  COLUMN_FOR_ZOHO_FIELD,
  layoutFormValuesToBody,
  zohoFieldsToFormValues,
  type LayoutFieldFormValues,
} from "@/lib/shipmentLayoutFields";

/**
 * Shared field-set for creating/editing a DomesticWarehouseShipment. Used by both
 * /shipments/new/form (create mode) and /shipments/[fileNumber] (edit mode) so the
 * markup and request-body shaping only exists once. The component owns its own
 * fetch/submit logic (POST for create, PATCH for edit) — the caller only supplies the
 * starting values and, in edit mode, the fileNumber.
 */
export interface ShipmentFormValues extends ExtraFieldFormValues {
  domesticType: string;
  status: string;
  accountId: string | null;
  shipperId: string | null;
  consigneeId: string | null;
  notifyPartyId: string | null;
  soldToId: string | null;
  shipToId: string | null;
  carrierId: string | null;
  placeOfReceipt: string;
  origin: string;
  destination: string;
  country: string;
  placeOfDelivery: string;
  incoTerms: string;
  proNumber: string;
  bolNumber: string;
  typeOfService: string;
  otherReference: string;
  paymentMethod: string;
  transitStartAt: string;
  transitEndAt: string;
  shipAt: string;
  cutoffAt: string;
  etaAt: string;
  atdAt: string;
  cargoDescription: string;
  insurance: string;
  insuranceValue: string;
  codFee: string;
  dryRun: string;
  totalCharges: string;
  serviceLevel: string;
  /** Zoho layout the form shows (src/lib/zohoLayouts.ts); "" or an unknown name falls back to the classic sections. */
  zohoLayoutName: string;
  /** Read-only here: set for child shipments, which pick from their department's layouts. */
  parentId: string | null;
  /** Read-only here: the Zoho department, which decides a child's layout choices. */
  zohoDepartmentId: string | null;
  /** Layout fields with no column of their own (`zohoFields`), by Zoho API name. */
  layoutFields: LayoutFieldFormValues;
}

export const EMPTY_SHIPMENT_FORM_VALUES: ShipmentFormValues = {
  domesticType: "",
  status: "SCHEDULED",
  accountId: null,
  shipperId: null,
  consigneeId: null,
  notifyPartyId: null,
  soldToId: null,
  shipToId: null,
  carrierId: null,
  placeOfReceipt: "",
  origin: "",
  destination: "",
  country: "",
  placeOfDelivery: "",
  incoTerms: "",
  proNumber: "",
  bolNumber: "",
  typeOfService: "",
  otherReference: "",
  paymentMethod: "",
  transitStartAt: "",
  transitEndAt: "",
  shipAt: "",
  cutoffAt: "",
  etaAt: "",
  atdAt: "",
  cargoDescription: "",
  insurance: "",
  insuranceValue: "",
  codFee: "",
  dryRun: "",
  totalCharges: "",
  serviceLevel: "",
  zohoLayoutName: "",
  parentId: null,
  zohoDepartmentId: null,
  layoutFields: {},
  ...emptyExtraFieldValues(),
};

function toDatetimeLocal(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function centsToDollarString(cents: unknown): string {
  if (cents === null || cents === undefined) return "";
  return (Number(cents) / 100).toFixed(2);
}

/** Any DomesticWarehouseShipment-shaped record (e.g. the raw prisma row from the GET route) -> form values. */
export function shipmentToFormValues(record: Record<string, unknown> | null | undefined): ShipmentFormValues {
  if (!record) return { ...EMPTY_SHIPMENT_FORM_VALUES };
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const idOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    domesticType: str(record.domesticType),
    status: str(record.status) || "SCHEDULED",
    accountId: idOrNull(record.accountId),
    shipperId: idOrNull(record.shipperId),
    consigneeId: idOrNull(record.consigneeId),
    notifyPartyId: idOrNull(record.notifyPartyId),
    soldToId: idOrNull(record.soldToId),
    shipToId: idOrNull(record.shipToId),
    carrierId: idOrNull(record.carrierId),
    placeOfReceipt: str(record.placeOfReceipt),
    origin: str(record.origin),
    destination: str(record.destination),
    country: str(record.country),
    placeOfDelivery: str(record.placeOfDelivery),
    incoTerms: str(record.incoTerms),
    proNumber: str(record.proNumber),
    bolNumber: str(record.bolNumber),
    typeOfService: str(record.typeOfService),
    otherReference: str(record.otherReference),
    paymentMethod: str(record.paymentMethod),
    transitStartAt: toDatetimeLocal(record.transitStartAt),
    transitEndAt: toDatetimeLocal(record.transitEndAt),
    shipAt: toDatetimeLocal(record.shipAt),
    cutoffAt: toDatetimeLocal(record.cutoffAt),
    etaAt: toDatetimeLocal(record.etaAt),
    atdAt: toDatetimeLocal(record.atdAt),
    cargoDescription: str(record.cargoDescription),
    insurance: str(record.insurance),
    insuranceValue: centsToDollarString(record.insuranceValueCents),
    codFee: centsToDollarString(record.codFeeCents),
    dryRun: str(record.dryRun),
    totalCharges: centsToDollarString(record.totalChargesCents),
    serviceLevel: str(record.serviceLevel),
    zohoLayoutName: str(record.zohoLayoutName),
    parentId: idOrNull(record.parentId),
    zohoDepartmentId: idOrNull(record.zohoDepartmentId),
    layoutFields: zohoFieldsToFormValues(record.zohoFields, toDatetimeLocal),
    ...extraFieldsToFormValues(record, toDatetimeLocal),
  };
}

function dateOrNull(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

function orNull(v: string): string | null {
  return v.trim() ? v : null;
}

/** Shapes ShipmentFormValues into the request body for both POST /api/shipments and PATCH /api/shipments/[fileNumber] — the API route is the source of truth for which fields it actually persists per method. */
export function shipmentFormValuesToBody(values: ShipmentFormValues): Record<string, unknown> {
  return {
    domesticType: orNull(values.domesticType),
    status: orNull(values.status),
    accountId: values.accountId,
    shipperId: values.shipperId,
    consigneeId: values.consigneeId,
    notifyPartyId: values.notifyPartyId,
    soldToId: values.soldToId,
    shipToId: values.shipToId,
    carrierId: values.carrierId,
    placeOfReceipt: orNull(values.placeOfReceipt),
    origin: orNull(values.origin),
    destination: orNull(values.destination),
    country: orNull(values.country),
    placeOfDelivery: orNull(values.placeOfDelivery),
    incoTerms: orNull(values.incoTerms),
    proNumber: orNull(values.proNumber),
    bolNumber: orNull(values.bolNumber),
    typeOfService: orNull(values.typeOfService),
    otherReference: orNull(values.otherReference),
    paymentMethod: orNull(values.paymentMethod),
    transitStartAt: dateOrNull(values.transitStartAt),
    transitEndAt: dateOrNull(values.transitEndAt),
    shipAt: dateOrNull(values.shipAt),
    cutoffAt: dateOrNull(values.cutoffAt),
    etaAt: dateOrNull(values.etaAt),
    atdAt: dateOrNull(values.atdAt),
    cargoDescription: orNull(values.cargoDescription),
    insurance: orNull(values.insurance),
    insuranceValue: orNull(values.insuranceValue),
    codFee: orNull(values.codFee),
    dryRun: orNull(values.dryRun),
    totalCharges: orNull(values.totalCharges),
    serviceLevel: orNull(values.serviceLevel),
    zohoLayoutName: orNull(values.zohoLayoutName),
    zohoFields: layoutFormValuesToBody(values.layoutFields),
    ...extraFieldsToBody(values),
  };
}

function nowDatetimeLocal(): string {
  return toDatetimeLocal(new Date());
}

export interface ShipmentFormProps {
  mode: "create" | "edit";
  /** Required in edit mode: identifies the record for PATCH and drives the Print/Billing/Cargo/Delivery Order links. */
  fileNumber?: string;
  initialValues: ShipmentFormValues;
  /** Create mode only: true when domesticType was already chosen on the /shipments/new type-picker step. */
  lockDomesticType?: boolean;
}

const fieldLabelClass = "text-xs font-medium text-zinc-600 dark:text-zinc-400";
const inputClass =
  "rounded border border-zinc-300 px-2.5 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-brand dark:disabled:bg-zinc-800";

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <input
        className={inputClass}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <select className={inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateTimeField({
  label,
  value,
  onChange,
  min,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <input
        type="datetime-local"
        className={inputClass}
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <textarea
        className={`${inputClass} min-h-20`}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Picklist over plain string options; keeps a current value that isn't in the list (e.g. a newer Zoho option) selectable. */
function PicklistField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled?: boolean;
}) {
  const all = value && !options.includes(value) ? [...options, value] : options;
  return <SelectField label={label} value={value} onChange={onChange} options={all.map((o) => ({ value: o, label: o }))} disabled={disabled} />;
}

/** Above this many options a multiselect renders as a dropdown checklist instead of chips. */
const MULTISELECT_CHIP_LIMIT = 6;

/**
 * Multiselect for long option lists (e.g. Zoho's Rebook Reasons / Escalation Reason):
 * a single box summarising the selection that opens a searchable checklist.
 */
function MultiSelectDropdown({
  label,
  selected,
  options,
  onToggle,
  onClear,
  disabled,
}: {
  label: string;
  selected: string[];
  options: string[];
  onToggle: (opt: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  const summary = selected.length === 0 ? "—" : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div ref={rootRef} className="relative flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={selected.join(", ")}
        className={`${inputClass} flex items-center justify-between gap-2 text-left`}
      >
        <span className={`truncate ${selected.length ? "" : "text-zinc-400"}`}>{summary}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full z-20 mt-1 w-full min-w-64 rounded border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center gap-2 border-b border-zinc-200 p-2 dark:border-zinc-800">
            <input
              autoFocus
              className={`${inputClass} w-full py-1 text-xs`}
              placeholder="Search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {selected.length > 0 && (
              <button type="button" onClick={onClear} className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400">
                Clear
              </button>
            )}
          </div>
          <ul className="max-h-60 overflow-auto py-1">
            {visible.map((opt) => (
              <li key={opt}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <input type="checkbox" className="h-4 w-4 shrink-0" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
                  <span>{opt}</span>
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="px-3 py-2 text-xs text-zinc-500">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Multiselect; value is the options joined with ";" (Zoho's encoding). Short lists render
 * as toggle chips, long ones as a dropdown checklist (MultiSelectDropdown).
 */
function MultiSelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled?: boolean;
}) {
  const selected = value.split(";").filter(Boolean);
  const all = [...options, ...selected.filter((s) => !options.includes(s))];
  function toggle(opt: string) {
    const next = selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt];
    onChange(next.join(";"));
  }
  if (all.length > MULTISELECT_CHIP_LIMIT) {
    return (
      <MultiSelectDropdown
        label={label}
        selected={selected}
        options={all}
        onToggle={toggle}
        onClear={() => onChange("")}
        disabled={disabled}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {all.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => toggle(opt)}
              className={`rounded-full border px-3 py-1 text-xs transition disabled:opacity-50 ${
                on
                  ? "border-brand bg-brand text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExtraField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ExtraFieldDef;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const common = { label: field.label, value, onChange, disabled };
  switch (field.type) {
    case "textarea":
      return <TextAreaField {...common} />;
    case "picklist":
      return <PicklistField {...common} options={field.options ?? []} />;
    case "multiselect":
      return <MultiSelectField {...common} options={field.options ?? []} />;
    case "datetime":
      return <DateTimeField {...common} />;
    case "decimal":
      return <TextField {...common} placeholder="0" />;
    case "currency":
      return <TextField {...common} placeholder="0.00" />;
    default:
      return <TextField {...common} />;
  }
}

function DateField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <input type="date" className={inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Checkbox; value is "true" or "" like every other form string. */
function BooleanField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 self-end py-1.5">
      <input type="checkbox" className="h-4 w-4" checked={value === "true"} disabled={disabled} onChange={(e) => onChange(e.target.checked ? "true" : "")} />
      <span className={fieldLabelClass}>{label}</span>
    </label>
  );
}

/** A layout field stored in `zohoFields` (no Shipment column of its own). */
function LayoutFieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: LayoutField;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const common = { label: field.label, value, onChange, disabled };
  switch (field.type) {
    case "textarea":
      return <TextAreaField {...common} />;
    case "picklist":
      return <PicklistField {...common} options={field.options ?? []} />;
    case "multiselect":
      return <MultiSelectField {...common} options={field.options ?? []} />;
    case "datetime":
      return <DateTimeField {...common} />;
    case "date":
      return <DateField {...common} />;
    case "boolean":
      return <BooleanField {...common} />;
    case "decimal":
      return <TextField {...common} placeholder="0" />;
    case "currency":
      return <TextField {...common} placeholder="0.00" />;
    default:
      return <TextField {...common} />;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-zinc-200 pt-4 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{title}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">{children}</div>
    </section>
  );
}

const actionButtonClass =
  "rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";

export default function ShipmentForm({ mode, fileNumber, initialValues, lockDomesticType }: ShipmentFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<ShipmentFormValues>(initialValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ShipmentFormValues>(key: K, value: ShipmentFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!values.domesticType) {
      setError("Domestic Type is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = shipmentFormValuesToBody(values);
      if (mode === "create") {
        const res = await fetch("/api/shipments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? "Failed to create shipment");
        }
        const { data } = await res.json();
        router.push(`/shipments/${data.fileNumber}`);
      } else {
        if (!fileNumber) throw new Error("Missing fileNumber for edit");
        const res = await fetch(`/api/shipments/${fileNumber}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? "Failed to save shipment");
        }
        const { data } = await res.json();
        setValues(shipmentToFormValues(data));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save shipment");
    } finally {
      setSaving(false);
    }
  }

  const minDatetime = mode === "create" ? nowDatetimeLocal() : undefined;

  // Existing Shipment fields that sit inside the Zoho sections, labelled as in Zoho.
  function renderExisting(key: ExistingSectionFieldKey, label: string) {
    switch (key) {
      case "origin":
      case "destination":
      case "placeOfReceipt":
        return <LocationLookupField label={label} value={values[key]} onChange={(v) => set(key, v)} disabled={saving} />;
      case "carrierId":
        return <ClientLookupField label={label} role="CARRIER" value={values.carrierId} onChange={(id) => set("carrierId", id)} disabled={saving} />;
      case "incoTerms":
        return <SelectField label={label} value={values.incoTerms} onChange={(v) => set("incoTerms", v)} options={toOptions(INCOTERMS_LABELS)} disabled={saving} />;
      case "cargoDescription":
        return <TextAreaField label={label} value={values.cargoDescription} onChange={(v) => set("cargoDescription", v)} disabled={saving} />;
      case "shipAt":
        return <DateTimeField label={label} value={values.shipAt} onChange={(v) => set("shipAt", v)} min={minDatetime} disabled={saving} />;
      case "totalCharges":
        return <TextField label={label} value={values.totalCharges} onChange={(v) => set("totalCharges", v)} disabled={saving} placeholder="0.00" />;
      case "proNumber":
      case "bolNumber":
        return <TextField label={label} value={values[key]} onChange={(v) => set(key, v)} disabled={saving} />;
    }
  }

  // One field of the selected Zoho layout: column-backed fields edit their Shipment column
  // (shown with the layout's label and options), the rest edit `layoutFields`.
  function renderLayoutField(field: LayoutField) {
    const backing = COLUMN_FOR_ZOHO_FIELD.get(field.apiName);
    if (backing?.kind === "existing") return <div key={field.apiName}>{renderExisting(backing.key, field.label)}</div>;
    if (backing?.kind === "extra") {
      const key = backing.field.key as ExtraFieldKey;
      return (
        <ExtraField
          key={field.apiName}
          field={{ ...backing.field, label: field.label, options: field.options ?? backing.field.options }}
          value={values[key]}
          onChange={(v) => set(key, v)}
          disabled={saving}
        />
      );
    }
    return (
      <LayoutFieldInput
        key={field.apiName}
        field={field}
        value={values.layoutFields[field.apiName] ?? ""}
        onChange={(v) => set("layoutFields", { ...values.layoutFields, [field.apiName]: v })}
        disabled={saving}
      />
    );
  }

  const layout = getLayout(values.zohoLayoutName);
  // TMS's own fields that a Zoho layout field duplicates are hidden while that layout is
  // shown — the Zoho field is the one that syncs.
  const layoutHas = (apiName: string) => !!layout?.sections.some((s) => s.fields.some((f) => f.apiName === apiName));
  // Top-level shipments pick an Air Ops layout, children one of their department's. A stored
  // value outside that list (e.g. an older top-level shipment made from a Dispatch ticket)
  // stays visible as its own option.
  const layoutOptions = layoutsForShipment(!!values.parentId, values.zohoDepartmentId).map((l) => ({ value: l.name, label: l.name }));
  if (values.zohoLayoutName && !layoutOptions.some((o) => o.value === values.zohoLayoutName)) layoutOptions.push({ value: values.zohoLayoutName, label: values.zohoLayoutName });

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Section title="Identification">
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>File Number</span>
          <input
            className={`${inputClass} bg-zinc-100 font-mono dark:bg-zinc-800`}
            value={fileNumber ?? "(generated on save)"}
            disabled
            readOnly
          />
        </label>
        {mode === "edit" && (
          <SelectField
            label="Status"
            value={values.status}
            onChange={(v) => set("status", v)}
            options={toOptions(SHIPMENT_STATUS_LABELS)}
          />
        )}
        <SelectField
          label="Domestic Type"
          value={values.domesticType}
          onChange={(v) => set("domesticType", v)}
          options={toOptions(DOMESTIC_TYPE_LABELS)}
          disabled={mode === "create" && lockDomesticType}
        />
        <SelectField label="Layout" value={values.zohoLayoutName} onChange={(v) => set("zohoLayoutName", v)} options={layoutOptions} disabled={saving} />
      </Section>

      <Section title="Parties">
        <ClientLookupField label="Account" role="ACCOUNT" value={values.accountId} onChange={(id) => set("accountId", id)} disabled={saving} />
        <ClientLookupField label="Shipper" role="SHIPPER" value={values.shipperId} onChange={(id) => set("shipperId", id)} disabled={saving} />
        <ClientLookupField label="Consignee" role="CONSIGNEE" value={values.consigneeId} onChange={(id) => set("consigneeId", id)} disabled={saving} />
      </Section>

      {layout
        ? layout.sections.map((section) => (
            <Section key={section.title} title={section.title}>
              {section.fields.map(renderLayoutField)}
            </Section>
          ))
        : ZOHO_SECTIONS.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.items.map((item) =>
            item.kind === "existing" ? (
              <div key={item.key}>{renderExisting(item.key, item.label)}</div>
            ) : (
              <ExtraField
                key={item.field.key}
                field={item.field}
                value={values[item.field.key as ExtraFieldKey]}
                onChange={(v) => set(item.field.key as ExtraFieldKey, v)}
                disabled={saving}
              />
            )
          )}
        </Section>
      ))}

      <Section title="Routing">
        <LocationLookupField label="Place of Delivery" value={values.placeOfDelivery} onChange={(v) => set("placeOfDelivery", v)} disabled={saving} />
        <TextField label="Country" value={values.country} onChange={(v) => set("country", v)} disabled={saving} />
      </Section>

      <Section title="Terms & References">
        <SelectField label="Type of Service" value={values.typeOfService} onChange={(v) => set("typeOfService", v)} options={toOptions(TYPE_OF_SERVICE_LABELS)} disabled={saving} />
        <TextField label="Other Reference" value={values.otherReference} onChange={(v) => set("otherReference", v)} disabled={saving} />
        <SelectField label="Payment Method" value={values.paymentMethod} onChange={(v) => set("paymentMethod", v)} options={toOptions(PAYMENT_METHOD_LABELS)} disabled={saving} />
      </Section>

      <Section title="Schedule">
        <DateTimeField label="Transit Start" value={values.transitStartAt} onChange={(v) => set("transitStartAt", v)} min={minDatetime} disabled={saving} />
        <DateTimeField label="Transit End" value={values.transitEndAt} onChange={(v) => set("transitEndAt", v)} min={minDatetime} disabled={saving} />
        <DateTimeField label="Cutoff At" value={values.cutoffAt} onChange={(v) => set("cutoffAt", v)} min={minDatetime} disabled={saving} />
        {!layoutHas("cf_eta") && (
          <DateTimeField label="ETA" value={values.etaAt} onChange={(v) => set("etaAt", v)} min={minDatetime} disabled={saving} />
        )}
        <DateTimeField label="ATD" value={values.atdAt} onChange={(v) => set("atdAt", v)} min={minDatetime} disabled={saving} />
      </Section>

      <Section title="Cargo & Charges">
        <TextField label="Insurance" value={values.insurance} onChange={(v) => set("insurance", v)} disabled={saving} />
        <TextField label="Insurance Value ($)" value={values.insuranceValue} onChange={(v) => set("insuranceValue", v)} disabled={saving} placeholder="0.00" />
        <TextField label="COD Fee ($)" value={values.codFee} onChange={(v) => set("codFee", v)} disabled={saving} placeholder="0.00" />
        <label className="col-span-full flex flex-col gap-1">
          <span className={fieldLabelClass}>Dry Run</span>
          <textarea
            className={`${inputClass} min-h-20`}
            value={values.dryRun}
            disabled={saving}
            placeholder={"One quote amount per line, e.g.\n150\n200 - 09/05/2026"}
            onChange={(e) => set("dryRun", e.target.value)}
          />
        </label>
        <TextField label="Service Level" value={values.serviceLevel} onChange={(v) => set("serviceLevel", v)} disabled={saving} />
      </Section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={() => router.push("/shipments")} disabled={saving} className={actionButtonClass}>
          Cancel
        </button>
        {mode === "edit" && fileNumber && (
          <>
            <Link href={`/shipments/${fileNumber}/print`} className={actionButtonClass}>
              Print
            </Link>
            <Link href={`/shipments/${fileNumber}/billing`} className={actionButtonClass}>
              Billing
            </Link>
            <Link href={`/shipments/${fileNumber}/cargo`} className={actionButtonClass}>
              Cargo
            </Link>
            <Link href={`/shipments/${fileNumber}/delivery-orders`} className={actionButtonClass}>
              Delivery Order
            </Link>
            <Link href={`/shipments/${fileNumber}/attachments`} className={actionButtonClass}>
              Attachments
            </Link>
          </>
        )}
        {mode === "edit" && fileNumber ? (
          <Link href={`/shipments/${fileNumber}/aes`} className={actionButtonClass} title="File Electronic Export Information with CBP (AESDirect)">
            AES
          </Link>
        ) : (
          <button type="button" disabled title="Save the shipment first to file AES" className={actionButtonClass}>
            AES
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}
