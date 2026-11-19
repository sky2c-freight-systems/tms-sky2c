# Vhaul4u TMS

A standalone rebuild of the "Domestic Warehouse" shipment module from a legacy ASP.NET
Web Forms freight/logistics TMS — Next.js 16 (App Router) + TypeScript + Tailwind +
Prisma (MongoDB). Branded for Vhaul4u, with a color theme sampled from
[vhaul4u.us](https://www.vhaul4u.us/)'s production CSS (navy header/brand, red CTAs,
dark-teal ink text, muted teal-gray secondary text, orange for validation errors).

## Why MongoDB, and what that changes vs. the original spec

This rebuild targets MongoDB (per project decision) instead of Postgres/SQL Server, which
forces two deliberate deviations from a literal relational reading of the spec:

- **Primary keys are Mongo ObjectId strings**, not autoincrement integers. Business keys
  (`Client.clientId`, `DomesticWarehouseShipment.fileNumber`, `DomesticWarehouseQuote.quoteNumber`)
  are unaffected and generated exactly per spec — see `src/lib/numbering.ts`.
- **Money is stored as integer cents (`Int`)**, not `Decimal`, because Prisma's MongoDB
  connector doesn't support the `Decimal` type. Integer cents avoids both the legacy bug
  (money stored as plain strings) and float rounding error. All conversion happens at the
  app boundary via `src/lib/money.ts` (backed by `decimal.js`) — never do dollar math by
  hand elsewhere in the codebase.
- Cross-collection references that aren't true parent/child ownership (e.g. a shipment's
  `shipperId` pointing at `Client`) are plain `ObjectId` scalar fields, not Prisma
  `@relation`s — Mongo has no FK enforcement, and modeling six Client "roles" as real
  relations would force six unrelated inverse array fields onto `Client` for no benefit.
  True ownership (`Shipment → CargoContainer → CargoItem`, `Shipment → ArInvoice`,
  `Quote → QuoteCargoItem`) does use real `@relation`s with cascade delete.

## Prerequisites

- Node.js 20+
- A MongoDB **replica set** (Prisma requires this for MongoDB, even a single-node one) —
  either:
  - [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) free tier (already a replica set), or
  - A local `mongod --replSet rs0` you initiate yourself (`rs.initiate()` in `mongosh`).

## Setup

```bash
npm install
# Copy .env.example to .env, then set DATABASE_URL to your MongoDB replica-set
# connection string. Configure QBO_*/ZOHO_*/SMTP_* when you need those integrations.
npx prisma generate
npx prisma db push     # creates collections/indexes from prisma/schema.prisma
npm run db:seed        # admin user + starter lookups/locations/charge-code map
npm run dev
```

Open http://localhost:3000 — log in with the seeded admin account:

- **Email:** `admin@example.com`
- **Password:** `ChangeMe123!`

Change this password (or create a new user and deactivate/remove the seed one) before
using this anywhere beyond local development — there's no self-serve signup or password
reset flow; user management is direct-to-database for now (single-tenant internal tool).

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MongoDB connection string, must include `replicaSet=...` |
| `SESSION_SECRET` | 32+ byte random string for iron-session cookie encryption |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | Intuit developer app credentials |
| `QBO_ENVIRONMENT` | `sandbox` or `production` |
| `QBO_REDIRECT_URI` | Must match the redirect URI registered in the Intuit developer app |
| `ZOHO_WEBHOOK_SECRET` | Shared secret Zoho Desk must send as `x-zoho-webhook-secret` on webhook calls |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | Outbound email for the "Email document" print action. If `SMTP_HOST` is empty, emails are logged to the console instead of sent — fine for local dev |

## Architecture

- **`prisma/schema.prisma`** — full data model (Client, DomesticWarehouseShipment,
  CargoContainer/CargoItem, DomesticWarehouseQuote/QuoteCargoItem, ArInvoice, ZohoSync,
  QboConnection, ChargeCodeQboItemMap, LookupValue, Location, DeliveryOrder, Counter, User).
- **`src/lib/numbering.ts`** — the one shared service generating Client IDs, shipment file
  numbers, and quote numbers. Uses an atomically-incremented `Counter` collection
  (seeded from the highest existing value on first use, then race-free afterward) instead
  of the legacy "scan for max, then +1 with no locking" pattern.
  - `Client.clientId`: first 5 chars of the name + an incrementing suffix (e.g. `Imaan1`).
  - `Shipment.fileNumber`: `${divisionId}${busLine}${10000+n}`.
  - `Quote.quoteNumber`: `600000 + n`.
- **`src/lib/clientService.ts`** — the one shared service for creating/resolving `Client`
  rows (`createClient`, `findOrCreateClient`, `searchClients`). Used by both the UI's
  "add new client" modals and the Zoho webhook handlers, so party resolution behavior
  (and its bug fixes) lives in exactly one place.
- **`src/lib/billing.ts`** — `recomputeShipmentBillableStatus`, the one place the
  `POSTED > IN_PROGRESS > CANCELLED > DELETED` rollup priority is implemented.
- **`src/lib/pdf/`** — one shared Puppeteer HTML→PDF pipeline (`renderToPdf.ts`) plus five
  document templates (`templates/*.ts`) that all pull from a single data loader
  (`documentData.ts`). Pagination is real CSS (`@page`, `break-inside: avoid`), not a
  client-side hack. The Bill of Lading includes a real generated QR code
  (`pdf/qrcode.ts`).
- **`src/lib/qbo.ts`** — QuickBooks Online OAuth + sync. Tokens persist in the
  `QboConnection` collection with expiry tracking and automatic refresh — never in
  server memory/global state.
- **`src/app/api/webhooks/zoho/`** — `ticket-created` and `ticket-updated` handlers.
  Always return HTTP 200 (failures are recorded on the `ZohoSync` row, not surfaced to
  Zoho, to avoid retry storms). Both real-name and address-fallback client resolution go
  through `findOrCreateClient`, which is careful never to also store the fallback
  address as the client's street address (the legacy app's "address printed twice on
  the BOL" bug).

## What's stubbed / needs real credentials to fully exercise

- **QuickBooks sync** needs a real Intuit developer app (`QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`)
  and at least one `ChargeCodeQboItemMap` row per charge code you actually bill
  (`/quickbooks/charge-codes` in the UI) — otherwise sync falls back to "any active QBO
  Item" and logs a visible warning, mirroring (and flagging) the legacy workaround.
- **Zoho webhooks** work against any payload shape close to what's documented in the
  build spec; Zoho Desk's actual custom-field key names are configurable per org, so
  double-check the key list in `src/lib/zohoMapping.ts` against your Zoho org's real
  custom field API names.
- **Email sending** logs to the console instead of delivering mail until `SMTP_HOST` is set.

## Known non-blocking warning

Next.js 16 deprecated the `middleware.ts` file convention in favor of `proxy.ts` (same
API). The app still builds and runs correctly on `middleware.ts`; renaming is a trivial
follow-up whenever you upgrade Next.js again.
