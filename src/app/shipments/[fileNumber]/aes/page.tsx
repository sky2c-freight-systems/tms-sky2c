import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { buildAesHandoff, resolveAppBaseUrl } from "@/lib/aes/aesHandoff";
import { findSubmissionByNonce, getShipmentAudit, type EventView, type SubmissionView } from "@/lib/aes/audit";
import { summarizeAesStatus } from "@/lib/aes/aesStatus";
import AesHandoffClient from "./AesHandoffClient";
import AesAuditPanel from "./AesAuditPanel";
import AesDetailsForm from "./AesDetailsForm";
import { EMPTY_AES_DETAILS } from "@/lib/aes/aesDetails";

// Always render fresh.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ fileNumber: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ShipmentAesPage({ params, searchParams }: PageProps) {
  const { fileNumber } = await params;
  const query = await searchParams;
  const session = await getSession();

  const handoff = await buildAesHandoff(fileNumber, {
    userEmail: session.email,
    baseUrl: resolveAppBaseUrl(await headers()),
  });
  if (!handoff) notFound();

  // CBP return values (passed on as cbp_<name>).
  const rawOutcome = typeof query.aes_return === "string" ? query.aes_return : null;
  const outcome = rawOutcome === "success" || rawOutcome === "failure" || rawOutcome === "status" ? rawOutcome : null;
  const cbpParams: Array<[string, string]> = Object.entries(query)
    .filter(([k, v]) => k.startsWith("cbp_") && typeof v === "string")
    .map(([k, v]) => [k.slice(4), v as string]);

  // Audit history and the matching filing for a CBP return. Must not break the page.
  let audit: { submissions: SubmissionView[]; events: EventView[] } | null = null;
  let verified: SubmissionView | null = null;
  try {
    const nonce = typeof query.aes_n === "string" ? query.aes_n : "";
    [audit, verified] = await Promise.all([
      getShipmentAudit(fileNumber),
      outcome && nonce ? findSubmissionByNonce(fileNumber, nonce) : Promise.resolve(null),
    ]);
  } catch (err) {
    console.error("[aes-audit] could not load the audit trail", fileNumber, err);
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AES Filing — File {fileNumber}</h1>
          <p className="text-sm text-zinc-500">
            Export filing with CBP (AESDirect) · CBP reference {handoff.mapping.srn}
          </p>
        </div>
        <Link href={`/shipments/${fileNumber}`} className="text-sm text-blue-600 hover:underline">
          ← Back to Shipment
        </Link>
      </div>

      <AesHandoffClient
        fileNumber={fileNumber}
        fieldsHash={handoff.fieldsHash}
        srn={handoff.mapping.srn}
        environment={handoff.config.environment}
        enabled={handoff.config.enabled}
        configError={handoff.config.configError}
        configWarnings={handoff.config.configWarnings}
        filingUrl={handoff.config.filingUrl}
        inquiryUrl={handoff.config.inquiryUrl}
        portalUrl={handoff.config.portalUrl}
        inquiry={handoff.inquiry}
        fields={handoff.mapping.fields}
        rows={handoff.mapping.rows}
        advisories={handoff.mapping.advisories}
        counts={handoff.mapping.counts}
        lineCount={handoff.mapping.lineCount}
        returnOutcome={outcome}
        returnParams={cbpParams}
        verifiedReturn={verified}
        statusSummary={audit ? summarizeAesStatus(audit.submissions) : null}
        filerId={handoff.config.filerId}
        detailsSlot={
          <AesDetailsForm
            fileNumber={fileNumber}
            initial={handoff.details?.details ?? EMPTY_AES_DETAILS}
            lines={handoff.mapping.lines}
            tmsValues={{
              mot: handoff.mapping.rows.find((r) => r.code === "MOT")?.value ?? "",
              portOfExport: handoff.mapping.rows.find((r) => r.code === "POE")?.value ?? "",
              portOfUnlading: handoff.mapping.rows.find((r) => r.code === "POU")?.value ?? "",
              transportRef: handoff.mapping.rows.find((r) => r.code === "BN")?.value ?? "",
              conveyanceName: handoff.mapping.rows.find((r) => r.code === "VN")?.value ?? "",
            }}
            updatedAt={handoff.details?.updatedAt ?? null}
            updatedByName={handoff.details?.updatedByName ?? null}
            missingRequired={handoff.mapping.rows.filter((r) => r.required && (r.status === "missing" || r.status === "not-in-tms")).length}
          />
        }
      />

      <div className="mt-8">
        <AesAuditPanel audit={audit} />
      </div>
    </div>
  );
}
