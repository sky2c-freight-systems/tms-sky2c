"use client";

import type { ClientRole } from "@/lib/clientService";

/**
 * Shared field-set for creating/editing a Client. Used both by the compact "+ Add new"
 * modal inside <ClientLookupField> (POST /api/clients) and by the full /clients/[id]
 * edit page (PATCH /api/clients/[id]) so the markup for name/address/contact/role
 * fields only exists once. The component is fully controlled: the caller owns
 * `values`/`onChange` and is responsible for turning the values into the right request
 * body shape (see clientFormValuesToCreateBody / clientFormValuesToPatchBody below).
 */
export interface ClientFormValues {
  name: string;
  street: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  isNonUS: boolean;
  telephone: string;
  fax: string;
  emailAddress: string;
  accountingEmailAddress: string;
  contact: string;
  contactLastName: string;
  exporterIdNumber: string;
  exporterIdType: string;
  scacCode: string;
  clientType: string;
  isActive: boolean;
  isShipper: boolean;
  isConsignee: boolean;
  isCarrier: boolean;
  isNotify: boolean;
  isSoldTo: boolean;
  isShipTo: boolean;
  isCustomer: boolean;
  isVendor: boolean;
  creditTermsDays: string;
  creditLimit: string;
  arDefaultTermsDays: string;
  arCreditLimit: string;
}

export const EMPTY_CLIENT_FORM_VALUES: ClientFormValues = {
  name: "",
  street: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zipCode: "",
  country: "",
  isNonUS: false,
  telephone: "",
  fax: "",
  emailAddress: "",
  accountingEmailAddress: "",
  contact: "",
  contactLastName: "",
  exporterIdNumber: "",
  exporterIdType: "",
  scacCode: "",
  clientType: "",
  isActive: true,
  isShipper: false,
  isConsignee: false,
  isCarrier: false,
  isNotify: false,
  isSoldTo: false,
  isShipTo: false,
  isCustomer: false,
  isVendor: false,
  creditTermsDays: "",
  creditLimit: "",
  arDefaultTermsDays: "",
  arCreditLimit: "",
};

const ROLE_CHECKBOXES: { role: ClientRole; field: keyof ClientFormValues; label: string }[] = [
  { role: "SHIPPER", field: "isShipper", label: "Shipper" },
  { role: "CONSIGNEE", field: "isConsignee", label: "Consignee" },
  { role: "CARRIER", field: "isCarrier", label: "Carrier" },
  { role: "NOTIFY", field: "isNotify", label: "Notify Party" },
  { role: "SOLD_TO", field: "isSoldTo", label: "Sold To" },
  { role: "SHIP_TO", field: "isShipTo", label: "Ship To" },
  { role: "ACCOUNT", field: "isCustomer", label: "Account (Customer)" },
];

/** Returns a fresh EMPTY_CLIENT_FORM_VALUES with the given role's checkbox pre-checked. */
export function makeDefaultClientFormValues(defaultRole?: ClientRole | null): ClientFormValues {
  const values = { ...EMPTY_CLIENT_FORM_VALUES };
  const match = ROLE_CHECKBOXES.find((r) => r.role === defaultRole);
  if (match) (values[match.field] as boolean) = true;
  return values;
}

/** Any Client-shaped record (e.g. the raw prisma row) -> form values, for the edit page. */
export function clientToFormValues(client: Record<string, unknown> | null | undefined): ClientFormValues {
  if (!client) return { ...EMPTY_CLIENT_FORM_VALUES };
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const bool = (v: unknown) => v === true;
  return {
    name: str(client.name),
    street: str(client.street),
    addressLine1: str(client.addressLine1),
    addressLine2: str(client.addressLine2),
    city: str(client.city),
    state: str(client.state),
    zipCode: str(client.zipCode),
    country: str(client.country),
    isNonUS: bool(client.isNonUS),
    telephone: str(client.telephone),
    fax: str(client.fax),
    emailAddress: str(client.emailAddress),
    accountingEmailAddress: str(client.accountingEmailAddress),
    contact: str(client.contact),
    contactLastName: str(client.contactLastName),
    exporterIdNumber: str(client.exporterIdNumber),
    exporterIdType: str(client.exporterIdType),
    scacCode: str(client.scacCode),
    clientType: str(client.clientType),
    isActive: client.isActive !== false,
    isShipper: bool(client.isShipper),
    isConsignee: bool(client.isConsignee),
    isCarrier: bool(client.isCarrier),
    isNotify: bool(client.isNotify),
    isSoldTo: bool(client.isSoldTo),
    isShipTo: bool(client.isShipTo),
    isCustomer: bool(client.isCustomer),
    isVendor: bool(client.isVendor),
    creditTermsDays: client.creditTermsDays === null || client.creditTermsDays === undefined ? "" : String(client.creditTermsDays),
    creditLimit:
      client.creditLimitCents === null || client.creditLimitCents === undefined
        ? ""
        : (Number(client.creditLimitCents) / 100).toString(),
    arDefaultTermsDays:
      client.arDefaultTermsDays === null || client.arDefaultTermsDays === undefined ? "" : String(client.arDefaultTermsDays),
    arCreditLimit:
      client.arCreditLimitCents === null || client.arCreditLimitCents === undefined
        ? ""
        : (Number(client.arCreditLimitCents) / 100).toString(),
  };
}

/** Form values -> POST /api/clients request body (roles collapsed into a ClientRole[]). */
export function clientFormValuesToCreateBody(values: ClientFormValues) {
  const roles: ClientRole[] = ROLE_CHECKBOXES.filter((r) => values[r.field]).map((r) => r.role);
  return {
    name: values.name.trim(),
    street: values.street || undefined,
    addressLine1: values.addressLine1 || undefined,
    addressLine2: values.addressLine2 || undefined,
    city: values.city || undefined,
    state: values.state || undefined,
    zipCode: values.zipCode || undefined,
    country: values.country || undefined,
    isNonUS: values.isNonUS,
    telephone: values.telephone || undefined,
    fax: values.fax || undefined,
    emailAddress: values.emailAddress || undefined,
    accountingEmailAddress: values.accountingEmailAddress || undefined,
    contact: values.contact || undefined,
    contactLastName: values.contactLastName || undefined,
    exporterIdNumber: values.exporterIdNumber.trim() || undefined,
    exporterIdType: values.exporterIdType || undefined,
    scacCode: values.scacCode.trim().toUpperCase() || undefined,
    clientType: values.clientType || undefined,
    roles,
    isVendor: values.isVendor,
    creditTermsDays: values.creditTermsDays ? Number(values.creditTermsDays) : undefined,
    creditLimit: values.creditLimit || undefined,
    arDefaultTermsDays: values.arDefaultTermsDays ? Number(values.arDefaultTermsDays) : undefined,
    arCreditLimit: values.arCreditLimit || undefined,
  };
}

/** Form values -> PATCH /api/clients/[id] request body (role flags sent directly as booleans). */
export function clientFormValuesToPatchBody(values: ClientFormValues) {
  return {
    name: values.name.trim(),
    street: values.street || null,
    addressLine1: values.addressLine1 || null,
    addressLine2: values.addressLine2 || null,
    city: values.city || null,
    state: values.state || null,
    zipCode: values.zipCode || null,
    country: values.country || null,
    isNonUS: values.isNonUS,
    telephone: values.telephone || null,
    fax: values.fax || null,
    emailAddress: values.emailAddress || null,
    accountingEmailAddress: values.accountingEmailAddress || null,
    contact: values.contact || null,
    contactLastName: values.contactLastName || null,
    exporterIdNumber: values.exporterIdNumber.trim() || null,
    exporterIdType: values.exporterIdType || null,
    scacCode: values.scacCode.trim().toUpperCase() || null,
    clientType: values.clientType || null,
    isActive: values.isActive,
    isShipper: values.isShipper,
    isConsignee: values.isConsignee,
    isCarrier: values.isCarrier,
    isNotify: values.isNotify,
    isSoldTo: values.isSoldTo,
    isShipTo: values.isShipTo,
    isCustomer: values.isCustomer,
    isVendor: values.isVendor,
    creditTermsDays: values.creditTermsDays ? Number(values.creditTermsDays) : null,
    creditLimit: values.creditLimit || null,
    arDefaultTermsDays: values.arDefaultTermsDays ? Number(values.arDefaultTermsDays) : null,
    arCreditLimit: values.arCreditLimit || null,
  };
}

export interface ClientFormProps {
  values: ClientFormValues;
  onChange: (values: ClientFormValues) => void;
  /** Compact mode hides credit-terms/isActive/clientType — used by the quick add-new modal. */
  compact?: boolean;
  disabled?: boolean;
  clientTypeOptions?: { value: string; label: string }[];
}

const inputClass =
  "w-full rounded border border-zinc-300 px-2.5 py-1.5 text-sm focus:border-zinc-500 focus:outline-none disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-brand dark:disabled:bg-zinc-800";
const labelClass = "block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1";

export default function ClientForm({ values, onChange, compact, disabled, clientTypeOptions }: ClientFormProps) {
  function set<K extends keyof ClientFormValues>(key: K, value: ClientFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClass}>Name *</label>
          <input
            className={inputClass}
            value={values.name}
            disabled={disabled}
            onChange={(e) => set("name", e.target.value)}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Street / Address Line 1</label>
          <input
            className={inputClass}
            value={values.street}
            disabled={disabled}
            onChange={(e) => set("street", e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Address Line 2</label>
          <input
            className={inputClass}
            value={values.addressLine2}
            disabled={disabled}
            onChange={(e) => set("addressLine2", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>City</label>
          <input className={inputClass} value={values.city} disabled={disabled} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>State</label>
          <input className={inputClass} value={values.state} disabled={disabled} onChange={(e) => set("state", e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Zip Code</label>
          <input
            className={inputClass}
            value={values.zipCode}
            disabled={disabled}
            onChange={(e) => set("zipCode", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Country</label>
          <input
            className={inputClass}
            value={values.country}
            disabled={disabled}
            onChange={(e) => set("country", e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={values.isNonUS}
            disabled={disabled}
            onChange={(e) => set("isNonUS", e.target.checked)}
          />
          Non-US address
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Telephone</label>
          <input
            className={inputClass}
            value={values.telephone}
            disabled={disabled}
            onChange={(e) => set("telephone", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Fax</label>
          <input className={inputClass} value={values.fax} disabled={disabled} onChange={(e) => set("fax", e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Email Address</label>
          <input
            className={inputClass}
            type="email"
            value={values.emailAddress}
            disabled={disabled}
            onChange={(e) => set("emailAddress", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Accounting Email Address</label>
          <input
            className={inputClass}
            type="email"
            value={values.accountingEmailAddress}
            disabled={disabled}
            onChange={(e) => set("accountingEmailAddress", e.target.value)}
            placeholder="Defaults to Email Address if blank"
          />
        </div>
        <div>
          <label className={labelClass}>Contact (First Name)</label>
          <input
            className={inputClass}
            value={values.contact}
            disabled={disabled}
            onChange={(e) => set("contact", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Contact Last Name</label>
          <input
            className={inputClass}
            value={values.contactLastName}
            disabled={disabled}
            onChange={(e) => set("contactLastName", e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass}>Client Type</label>
          {clientTypeOptions && clientTypeOptions.length > 0 ? (
            <select
              className={inputClass}
              value={values.clientType}
              disabled={disabled}
              onChange={(e) => set("clientType", e.target.value)}
            >
              <option value="">—</option>
              {clientTypeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass}
              value={values.clientType}
              disabled={disabled}
              onChange={(e) => set("clientType", e.target.value)}
            />
          )}
        </div>
        {!compact && (
          <>
            <div>
              <label className={labelClass}>EIN (for AES export filings)</label>
              <input
                className={inputClass}
                value={values.exporterIdNumber}
                disabled={disabled}
                onChange={(e) => set("exporterIdNumber", e.target.value)}
                placeholder="Only needed when this client is the exporter"
              />
            </div>
            <div>
              <label className={labelClass}>EIN Type</label>
              <select
                className={inputClass}
                value={values.exporterIdType}
                disabled={disabled}
                onChange={(e) => set("exporterIdType", e.target.value)}
              >
                <option value="">—</option>
                <option value="E">EIN</option>
                <option value="D">DUNS</option>
                <option value="T">Foreign entity</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>SCAC (for AES export filings)</label>
              <input
                className={inputClass}
                value={values.scacCode}
                disabled={disabled}
                maxLength={4}
                onChange={(e) => set("scacCode", e.target.value)}
                placeholder="Only needed when this client is a carrier"
              />
            </div>
          </>
        )}
      </div>

      <div>
        <label className={labelClass}>Roles</label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ROLE_CHECKBOXES.map((r) => (
            <label key={r.role} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values[r.field] as boolean}
                disabled={disabled}
                onChange={(e) => set(r.field, e.target.checked as ClientFormValues[typeof r.field])}
              />
              {r.label}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.isVendor}
              disabled={disabled}
              onChange={(e) => set("isVendor", e.target.checked)}
            />
            Vendor (AP)
          </label>
        </div>
      </div>

      {!compact && (
        <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelClass}>Credit Terms (days)</label>
              <input
                className={inputClass}
                type="number"
                value={values.creditTermsDays}
                disabled={disabled}
                onChange={(e) => set("creditTermsDays", e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Credit Limit ($)</label>
              <input
                className={inputClass}
                value={values.creditLimit}
                disabled={disabled}
                onChange={(e) => set("creditLimit", e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>AR Default Terms (days)</label>
              <input
                className={inputClass}
                type="number"
                value={values.arDefaultTermsDays}
                disabled={disabled}
                onChange={(e) => set("arDefaultTermsDays", e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>AR Credit Limit ($)</label>
              <input
                className={inputClass}
                value={values.arCreditLimit}
                disabled={disabled}
                onChange={(e) => set("arCreditLimit", e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.isActive}
              disabled={disabled}
              onChange={(e) => set("isActive", e.target.checked)}
            />
            Active
          </label>
        </div>
      )}
    </div>
  );
}
