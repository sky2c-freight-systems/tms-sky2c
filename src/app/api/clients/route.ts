import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { createClient, ROLE_FLAG_FIELD, type ClientRole } from "@/lib/clientService";
import { dollarsToCents } from "@/lib/money";
import { escapeRegex } from "@/lib/mongoText";

const ROLE_VALUES: [ClientRole, ...ClientRole[]] = [
  "SHIPPER",
  "CONSIGNEE",
  "CARRIER",
  "NOTIFY",
  "SOLD_TO",
  "SHIP_TO",
  "ACCOUNT",
];

function isClientRole(value: string | null): value is ClientRole {
  return !!value && (ROLE_VALUES as string[]).includes(value);
}

/**
 * GET /api/clients?q=&role=&isActive=&page=&pageSize=
 * Full paginated list for the /clients admin page.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? undefined;
  const roleParam = searchParams.get("role");
  const role = isClientRole(roleParam) ? roleParam : undefined;
  const isActiveParam = searchParams.get("isActive");
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(1, Number(searchParams.get("pageSize") ?? "50") || 50));

  const where: Prisma.ClientWhereInput = {};
  if (isActiveParam === "true") where.isActive = true;
  else if (isActiveParam === "false") where.isActive = false;
  if (role) (where as Record<string, unknown>)[ROLE_FLAG_FIELD[role]] = true;
  if (q) {
    where.OR = [
      { name: { contains: escapeRegex(q), mode: "insensitive" } },
      { clientId: { contains: escapeRegex(q), mode: "insensitive" } },
      { emailAddress: { contains: escapeRegex(q), mode: "insensitive" } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.client.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize });
}

const createClientSchema = z.object({
  name: z.string().min(1),
  street: z.string().nullish(),
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  zipCode: z.string().nullish(),
  country: z.string().nullish(),
  isNonUS: z.boolean().optional(),
  telephone: z.string().nullish(),
  fax: z.string().nullish(),
  emailAddress: z.string().nullish(),
  accountingEmailAddress: z.string().nullish(),
  contact: z.string().nullish(),
  contactLastName: z.string().nullish(),
  exporterIdNumber: z.string().trim().max(20).nullish(),
  exporterIdType: z.enum(["E", "D", "T"]).or(z.literal("")).nullish(),
  scacCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "SCAC is 2-4 letters").or(z.literal("")).nullish(),
  clientType: z.string().nullish(),
  roles: z.array(z.enum(ROLE_VALUES)).optional(),
  isVendor: z.boolean().optional(),
  creditTermsDays: z.number().int().nullish(),
  creditLimit: z.union([z.string(), z.number()]).nullish(),
  arDefaultTermsDays: z.number().int().nullish(),
  arCreditLimit: z.union([z.string(), z.number()]).nullish(),
});

/**
 * POST /api/clients — create via the shared clientService.createClient.
 * creditLimit/arCreditLimit are accepted as dollar strings/numbers and converted to cents here.
 */
export async function POST(request: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  let creditLimitCents: number | null;
  let arCreditLimitCents: number | null;
  try {
    creditLimitCents = dollarsToCents(data.creditLimit ?? undefined);
    arCreditLimitCents = dollarsToCents(data.arCreditLimit ?? undefined);
  } catch {
    return NextResponse.json({ error: "Invalid credit limit amount" }, { status: 400 });
  }

  const client = await createClient({
    name: data.name,
    street: data.street ?? undefined,
    addressLine1: data.addressLine1 ?? undefined,
    addressLine2: data.addressLine2 ?? undefined,
    city: data.city ?? undefined,
    state: data.state ?? undefined,
    zipCode: data.zipCode ?? undefined,
    country: data.country ?? undefined,
    isNonUS: data.isNonUS,
    telephone: data.telephone ?? undefined,
    fax: data.fax ?? undefined,
    emailAddress: data.emailAddress ?? undefined,
    accountingEmailAddress: data.accountingEmailAddress ?? undefined,
    contact: data.contact ?? undefined,
    contactLastName: data.contactLastName ?? undefined,
    exporterIdNumber: data.exporterIdNumber || undefined,
    exporterIdType: data.exporterIdType || undefined,
    scacCode: data.scacCode || undefined,
    clientType: data.clientType ?? undefined,
    roles: data.roles,
    creditTermsDays: data.creditTermsDays ?? undefined,
    creditLimitCents: creditLimitCents ?? undefined,
    arDefaultTermsDays: data.arDefaultTermsDays ?? undefined,
    arCreditLimitCents: arCreditLimitCents ?? undefined,
  });

  // isVendor (AP) isn't part of the ClientRole union createClient understands — set it directly.
  const finalClient = data.isVendor
    ? await prisma.client.update({ where: { id: client.id }, data: { isVendor: true } })
    : client;

  return NextResponse.json(finalClient, { status: 201 });
}
