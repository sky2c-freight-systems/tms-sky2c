import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Single shared numbering service for Client IDs, Shipment file numbers, and Quote
 * numbers. The legacy app reimplemented each of these 2-3 times (once in the UI, again
 * in the Zoho webhook handler) with subtly different bugs — most notably relying on
 * "scan for max existing value, then +1" with no locking, which races under concurrent
 * requests. This module fixes that with a Counter collection: each numbering "scope"
 * (e.g. "client:Imaan", "file:1010", "child:101060000", "quote") gets an atomically-incremented counter,
 * seeded from the highest existing value in the underlying collection the first time
 * that scope is used (matching the legacy semantics of "start after whatever already
 * exists"), then purely atomic afterward.
 */

function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Atomically returns the next integer for the given counter scope, seeding it from
 * `seedFn()` (the highest existing value already in use for that scope) on first use.
 */
async function nextInScope(key: string, seedFn: () => Promise<number>): Promise<number> {
  try {
    const updated = await prisma.counter.update({
      where: { key },
      data: { value: { increment: 1 } },
    });
    return updated.value;
  } catch (err) {
    if (!isNotFound(err)) throw err;

    const seed = await seedFn();
    try {
      const created = await prisma.counter.create({ data: { key, value: seed + 1 } });
      return created.value;
    } catch (createErr) {
      if (!isUniqueConflict(createErr)) throw createErr;
      // Another request seeded the counter first — just increment it now.
      const updated = await prisma.counter.update({
        where: { key },
        data: { value: { increment: 1 } },
      });
      return updated.value;
    }
  }
}

/** First 5 characters of the client name (or the whole name if <=5 chars), whitespace stripped. */
export function deriveClientIdPrefix(clientName: string): string {
  const stripped = clientName.trim().replace(/\s+/g, "");
  return stripped.length <= 5 ? stripped : stripped.slice(0, 5);
}

async function seedClientSuffix(prefix: string): Promise<number> {
  const existing = await prisma.client.findMany({
    where: { clientId: { startsWith: prefix } },
    select: { clientId: true },
  });
  const suffixPattern = new RegExp(`^${escapeRegex(prefix)}(\\d+)$`);
  let max = 0;
  for (const { clientId } of existing) {
    const match = clientId.match(suffixPattern);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

/** Generates the next `clientId` business key for a new Client, e.g. "Imaan1", "Imaan2". */
export async function generateClientId(clientName: string): Promise<string> {
  const prefix = deriveClientIdPrefix(clientName);
  const suffix = await nextInScope(`client:${prefix}`, () => seedClientSuffix(prefix));
  return `${prefix}${suffix}`;
}

/**
 * Shipment file-number series since 2026-10: "1010" followed by a counter starting at
 * 60000 (101060000, 101060001, ...). Older shipments keep their `${divisionId}${busLine}…`
 * numbers (e.g. 9965…); the shipment's divisionId/busLine columns are unchanged.
 */
const FILE_SERIES_PREFIX = "1010";
const FILE_SERIES_FIRST = 60000;

async function seedFileSeries(): Promise<number> {
  const existing = await prisma.domesticWarehouseShipment.findMany({
    where: { fileNumber: { startsWith: FILE_SERIES_PREFIX } },
    select: { fileNumber: true },
  });
  const pattern = new RegExp(`^${FILE_SERIES_PREFIX}(\\d+)$`);
  let max = FILE_SERIES_FIRST - 1;
  for (const { fileNumber } of existing) {
    const match = fileNumber.match(pattern);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

/** Next file number for a new (top-level) shipment: 101060000, 101060001, ... */
export async function generateShipmentFileNumber(): Promise<string> {
  const suffix = await nextInScope(`file:${FILE_SERIES_PREFIX}`, seedFileSeries);
  return `${FILE_SERIES_PREFIX}${suffix}`;
}

async function seedChildSuffix(parentFileNumber: string): Promise<number> {
  const existing = await prisma.domesticWarehouseShipment.findMany({
    // Escaped: Prisma's MongoDB startsWith is an unescaped regex (see src/lib/mongoText.ts).
    where: { fileNumber: { startsWith: `${escapeRegex(parentFileNumber)}-` } },
    select: { fileNumber: true },
  });
  const pattern = new RegExp(`^${escapeRegex(parentFileNumber)}-(\\d+)$`);
  let max = 0;
  for (const { fileNumber } of existing) {
    const match = fileNumber.match(pattern);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

/** Next file number for a child shipment: the parent's number plus -1, -2, ... */
export async function generateChildFileNumber(parentFileNumber: string): Promise<string> {
  const suffix = await nextInScope(`child:${parentFileNumber}`, () => seedChildSuffix(parentFileNumber));
  return `${parentFileNumber}-${suffix}`;
}

async function seedQuoteNumber(): Promise<number> {
  const latest = await prisma.domesticWarehouseQuote.findFirst({
    orderBy: { quoteNumber: "desc" },
    select: { quoteNumber: true },
  });
  return Math.max(latest?.quoteNumber ?? 0, 599999); // so the first generated number is 600000
}

/** Generates the next quote number in the `600000 + n` scheme. */
export async function generateQuoteNumber(): Promise<number> {
  return nextInScope("quote", seedQuoteNumber);
}

async function seedInvoiceSuffix(fileNumber: string): Promise<number> {
  const existing = await prisma.arInvoice.findMany({
    where: { fileNumber, invoiceNo: { startsWith: `${fileNumber}-` } },
    select: { invoiceNo: true },
  });
  const suffixPattern = new RegExp(`^${escapeRegex(fileNumber)}-(\\d+)$`);
  let max = 0;
  for (const { invoiceNo } of existing) {
    const match = invoiceNo?.match(suffixPattern);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

/** Generates the next `invoiceNo` for a shipment's AR invoices: `${fileNumber}-1`, `-2`, ... */
export async function generateInvoiceNumber(fileNumber: string): Promise<string> {
  const suffix = await nextInScope(`invoice:${fileNumber}`, () => seedInvoiceSuffix(fileNumber));
  return `${fileNumber}-${suffix}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
