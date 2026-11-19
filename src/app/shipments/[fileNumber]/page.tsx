"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ShipmentForm, { EMPTY_SHIPMENT_FORM_VALUES, shipmentToFormValues, type ShipmentFormValues } from "@/components/ShipmentForm";
import Spinner from "@/components/Spinner";
import PickupBolPanel from "@/components/PickupBolPanel";
import HawbPanel from "@/components/HawbPanel";
import { SHIPMENT_STATUS_LABELS } from "@/lib/enumLabels";

interface FamilyMember {
  fileNumber: string;
  status: string;
  zohoLayoutName: string | null;
}

export default function ShipmentEditPage() {
  const params = useParams<{ fileNumber: string }>();
  const fileNumber = params.fileNumber;

  const [values, setValues] = useState<ShipmentFormValues>({ ...EMPTY_SHIPMENT_FORM_VALUES });
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parent, setParent] = useState<FamilyMember | null>(null);
  const [children, setChildren] = useState<FamilyMember[]>([]);
  const [isDispatch, setIsDispatch] = useState(false);
  const [isAirOps, setIsAirOps] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/shipments/${fileNumber}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to load shipment");
        const { data, parent, children, isDispatch, isAirOps } = await res.json();
        if (!cancelled) {
          setValues(shipmentToFormValues(data));
          setParent(parent ?? null);
          setChildren(children ?? []);
          setIsDispatch(!!isDispatch);
          setIsAirOps(!!isAirOps);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load shipment");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileNumber]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Link href="/shipments" className="mb-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400">
          &larr; Back to Shipments
        </Link>
        <p className="text-sm text-zinc-500">Shipment {fileNumber} not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link href="/shipments" className="mb-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400">
        &larr; Back to Shipments
      </Link>
      <h1 className={`text-xl font-semibold ${parent || children.length ? "mb-2" : "mb-4"}`}>Shipment {fileNumber}</h1>
      {parent && (
        <p className={`text-sm text-zinc-500 ${children.length ? "mb-2" : "mb-4"}`}>
          Child shipment of{" "}
          <Link href={`/shipments/${parent.fileNumber}`} className="font-mono text-blue-600 hover:underline dark:text-blue-400">
            {parent.fileNumber}
          </Link>
        </p>
      )}
      {children.length > 0 && (
        <div className="mb-4 rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <p className="mb-1.5 text-xs font-medium text-zinc-500">Child shipments ({children.length})</p>
          <ul className="space-y-1">
            {children.map((c) => (
              <li key={c.fileNumber} className="flex items-center gap-2">
                <Link href={`/shipments/${c.fileNumber}`} className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400">
                  {c.fileNumber}
                </Link>
                {c.zohoLayoutName && (
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    {c.zohoLayoutName}
                  </span>
                )}
                <span className="text-xs text-zinc-500">{SHIPMENT_STATUS_LABELS[c.status] ?? c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner className="h-4 w-4 text-brand" />
          Loading...
        </p>
      ) : (
        <>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {isDispatch && <PickupBolPanel fileNumber={fileNumber} />}
          {isAirOps && <HawbPanel fileNumber={fileNumber} />}
          <ShipmentForm mode="edit" fileNumber={fileNumber} initialValues={values} />
        </>
      )}
    </div>
  );
}
