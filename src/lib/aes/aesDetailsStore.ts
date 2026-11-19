import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readAesDetails, type AesDetails } from "@/lib/aes/aesDetails";
import { recordDetailsSaved, type AuditActor, type RequestMeta } from "@/lib/aes/audit";

// Only place that reads/writes ShipmentAes.
// Reads never throw: on error we act as if nothing is saved.

type DetailsDb = Pick<PrismaClient, "shipmentAes">;

export interface StoredAesDetails {
  details: AesDetails;
  updatedAt: string | null;
  updatedByName: string | null;
}

export async function getAesDetails(shipmentId: string, db: DetailsDb = prisma): Promise<StoredAesDetails | null> {
  try {
    const row = await db.shipmentAes.findUnique({ where: { shipmentId } });
    if (!row) return null;
    return { details: readAesDetails(row.details), updatedAt: row.updatedAt.toISOString(), updatedByName: row.updatedByName ?? null };
  } catch (err) {
    console.error("[aes-details] could not read AES details — continuing without them", shipmentId, err);
    return null;
  }
}

// Which fields changed (for the audit entry).
export function changedKeys(before: AesDetails | null, after: AesDetails): string[] {
  const keys: string[] = [];
  const b = (before ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(after)) {
    if (k === "lines") continue;
    if ((b[k] ?? "") !== v) keys.push(k);
  }
  const bl = (before?.lines ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(after.lines)) if (JSON.stringify(bl[k] ?? null) !== JSON.stringify(v)) keys.push(`line ${k}`);
  for (const k of Object.keys(bl)) if (!(k in after.lines)) keys.push(`line ${k} (removed)`);
  return keys;
}

// Saves the details and logs it in the audit. Throws if the save fails.
export async function saveAesDetails(
  input: { shipmentId: string; fileNumber: string; environment: string; details: AesDetails; actor: AuditActor; meta: RequestMeta },
  db: DetailsDb = prisma
): Promise<{ changed: string[] }> {
  const before = await getAesDetails(input.shipmentId, db);
  const changed = changedKeys(before?.details ?? null, input.details);
  await db.shipmentAes.upsert({
    where: { shipmentId: input.shipmentId },
    create: {
      shipmentId: input.shipmentId,
      fileNumber: input.fileNumber,
      details: input.details,
      updatedBy: input.actor.userId,
      updatedByName: input.actor.name || input.actor.email,
    },
    update: { details: input.details, updatedBy: input.actor.userId, updatedByName: input.actor.name || input.actor.email },
  });
  await recordDetailsSaved({
    shipmentId: input.shipmentId,
    fileNumber: input.fileNumber,
    environment: input.environment,
    actor: input.actor,
    meta: input.meta,
    changed,
  });
  return { changed };
}
