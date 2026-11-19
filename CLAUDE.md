@AGENTS.md

# tms-sky2c — project memory

Sky2C / Vhaul4u TMS. A rebuild of the **Domestic Warehouse** module of the legacy ASP.NET
Web Forms app "Sky2CWeb", grown into a Zoho Desk-driven shipment, billing and tracking system.

> Correction to team lore: this is **not** NestJS + MySQL. It is Next.js 16 (App Router) +
> React 19 + Prisma 6 on **MongoDB**. There is no MySQL anywhere in this repo.

## Stack

- Next.js 16.2 (App Router, `output: "standalone"`), React 19.2, TypeScript (strict), Tailwind 4.
  Per AGENTS.md, Next 16 differs from training data. Check `node_modules/next/dist/docs/` first.
- Prisma 6.19 with the **MongoDB** connector. A replica set is required, even locally. `binaryTargets` pins `debian-openssl-3.0.x` for Docker.
- iron-session 8 (cookies), bcryptjs, zod 4, react-hook-form, date-fns, decimal.js.
- Puppeteer 25 for HTML→PDF, qrcode for the BOL QR.
- node-quickbooks + intuit-oauth (QBO), nodemailer + Microsoft Graph (mail).
- Path alias `@/*` → `src/*`.

## Commands

```bash
npm install            # postinstall runs `prisma generate`
npx prisma db push     # sync collections/indexes from prisma/schema.prisma (no migrations on Mongo)
npm run db:seed        # admin@example.com / ChangeMe123! + lookups. Idempotent upserts
npm run dev
npx tsc --noEmit       # the real type gate (next build skips it — see below)
npm run lint
```

## Environments and deploy

- **CI** (`.github/workflows/ci.yml`) runs `tsc --noEmit` and lint on push to `main`/`qa` and on PRs. This is the **only** type check: `next.config.ts` sets `typescript.ignoreBuildErrors: true` because the 1-CPU build host OOM'd on tsc. Never rely on `next build` to catch type errors.
- **Deploy QA** (`.github/workflows/deploy-qa.yml`) runs on push to `main` on a **self-hosted Windows runner**. It stops the NSSM service `TMS-QA`, robocopies into `C:\Apps\tms-qa` (excluding `.env`), runs `npm ci` + `prisma generate` + `build` in place, then restarts. Expect about 2-3 min of downtime. Building in a staging folder and renaming it breaks Prisma's module path, so don't "optimize" that. Deploys are serialized (`cancel-in-progress: false`).
- **Dockerfile** is a separate Debian/bookworm image for Coolify (the Vhaul4u host). It uses apt `chromium` + `PUPPETEER_EXECUTABLE_PATH`, and a placeholder `DATABASE_URL` at build time. *(Inferred: Coolify = Vhaul4u, Windows/NSSM = Sky2C QA.)*
- ⚠️ The QA database (`qa-tms-sky2c`) **processes live Zoho Desk tickets**. A local `.env` pointing at it is touching real data. Keep `ZOHO_DESK_PUSH_ENABLED` and `ZOHO_DESK_REPLY_ENABLED` **false** locally, or you will write to real tickets.
- `.env*` is gitignored except `.env.example`. Its comments record real incidents. Read them.

## Auth (two separate sessions)

- **Staff**: `User` model, bcrypt password, iron-session cookie `dwtms_session`. Use `getSession()`/`requireSession()` in `src/lib/session.ts`. There is no signup or password reset; users are managed directly in the DB.
- **Customer portal**: `CustomerAccount` (no password), 6-digit email OTP (bcrypt-hashed, 10 min TTL, max 5 attempts, resend cooldown), cookie `dwtms_customer_session`. Registration only links to an **existing** `Client` with `isCustomer=true`, matched by email or by phone (last 10 digits). It never creates a Client. See `src/lib/otp.ts`, `customerAccount.ts`, `customerSession.ts`.
- `src/middleware.ts` (Edge) gates everything. Public: `/login`, `/tracking/*`, `/api/tracking/*`, `/customer/login|register`, and the CBP AES return routes `/api/aes/return/*` and `/api/aes/weblink/return` (redirect-only; the nonce route `/api/aes/return/<outcome>/<fn>/<nonce>` also writes to the AES audit, but only for a matching nonce). Self-authenticating: `/api/webhooks/zoho/*` (shared secret) and `/api/quickbooks/callback`. Cookie names are duplicated as literals there because Edge can't import `next/headers`. Keep them in sync.
- Login redirect: middleware sends unauthenticated page requests to `/login?from=<path + query>`. The login page follows `from` only when it is an in-app path (starts with `/`, not `//` or `/\`), otherwise it goes to `/`.
- All session code falls back to a hard-coded dev secret if `SESSION_SECRET` is unset. Production must set it.
- Next 16 deprecated `middleware.ts` in favor of `proxy.ts`. It still works; renaming is a pending follow-up.

## Data model (prisma/schema.prisma)

Conventions:
- IDs are Mongo ObjectId strings. Business keys are separate unique fields.
- **Money is integer cents (`Int`)**, because Mongo has no Decimal. Convert **only** through `src/lib/money.ts` (`dollarsToCents`, `centsToDollars`, `formatCents`). No hand-rolled dollar math.
- Real `@relation` with cascade is used **only** for true ownership: Shipment → CargoContainer → CargoItem, Shipment → ArInvoice/DeliveryOrder/TrackingEvent/GeneratedDocument, Quote → QuoteCargoItem, ArInvoice → ArInvoiceLineItem. Party references (`accountId`, `shipperId`, `consigneeId`, `notifyPartyId`, `soldToId`, `shipToId`, `carrierId`) are plain ObjectId scalars pointing at `Client`, not relations.
- Mongo/Prisma gotcha: `field: null` does not match a missing field. Use `{ OR: [{ field: null }, { field: { isSet: false } }] }` (see otp.ts, qbo.ts, zohoShipmentSync.ts).
- Mongo/Prisma gotcha: `contains`/`startsWith`/insensitive `equals` are **unescaped regex**. Always pass user/Zoho input through `escapeRegex` from `src/lib/mongoText.ts`.

Models:
- `User`, `Counter` (atomic numbering), `AppSetting` (k/v, e.g. `autoPickupBol`).
- `Client` is the single party master. It carries multi-role flags (`isShipper/Consignee/Carrier/Notify/SoldTo/ShipTo/Customer/Vendor`), AR terms, the QBO mirror (`qboCustomerId`, `qboSyncToken`) and `accountingEmailAddress` (used as the QBO invoice email).
- `LookupValue` (category + value: CLIENT_TYPE, CONTAINER_TYPE, PIECE_TYPE, CHARGE_CODE, CURRENCY), `Location`.
- `DomesticWarehouseShipment` is the core entity:
  - Status enum mirrors Zoho statuses 1:1: OPEN, SCHEDULED, INTRANSIT, PICKED_UP, ON_HOLD, DELIVERED, ON_HAND, ESCALATED, QUOTE_SENT, CANCELLED, CLOSED.
  - Also has DomesticType, IncoTerms, TypeOfService (9 R/W/T combos), PaymentMethod and BillableStatus enums.
  - Parent/child fields: `parentId`, `zohoTicketId`, `parentZohoTicketId`, `zohoDepartmentId`, `zohoLayoutName`.
  - `zohoFields` (Json) stores layout fields that have no column of their own.
  - `dryRun` mirrors Zoho `cf_multiple_quotes`.
  - Dispatch/pickup columns hold the Zoho sections.
- `ShipmentTrackingEvent` is append-only. Never update or delete rows; a correction is a new event.
- `CargoContainer`/`CargoItem` (item has an optional vehicle extension), `DeliveryOrder`.
- `DomesticWarehouseQuote` (16 accessorial flags; status DRAFT|SENT|ACCEPTED|EXPIRED|CONVERTED), `QuoteCargoItem`.
- `ArInvoice` has a real `isAdjustment`/`adjustmentOfId`/`reversalOfId` (legacy parsed "ADJ"/"R" out of InvoiceNo) and a QBO mirror. `ArInvoiceLineItem` holds Dry Run lines.
- `ChargeCodeQboItemMap`, `QboConnection` (OAuth tokens persisted with expiry, never in memory).
- `GeneratedDocument` stores PDF bytes **in Mongo**, versioned (never updated) and deduped by `dataHash`.
- `ZohoSync` is the audit row per ticket, holding the raw payload, syncStatus and errorMessage.
- `CustomerAccount`, `OtpChallenge`.
- `AesSubmission`, `AesAuditEvent`: the append-only AES/CBP audit trail (soft refs, no cascade, no TTL). Only `src/lib/aes/audit.ts` touches them; see the AES section.
- `ShipmentAes` (added 2026-11-18): one per shipment (unique `shipmentId` soft ref, `fileNumber`, `details` Json, `updatedBy`/`updatedByName`). Holds the AES details entered on the AES page. **Only `src/lib/aes/aesDetailsStore.ts` reads or writes it.** Needs `npx prisma db push`.

## Numbering (src/lib/numbering.ts, the ONLY place)

`nextInScope(key)` does an atomic `$inc` on `Counter`, seeded once from the max existing value. This replaces legacy "max + 1 with no locking".
- Client ID: first 5 chars of the name (whitespace stripped) + counter, e.g. `Imaan1`.
- Shipment file number (**since 2026-10**): `1010` + counter from 60000 → `101060000`, `101060001`, … Older `9965…`/`2065…` (`${divisionId}${busLine}${10000+n}`) numbers are left untouched. Zoho shipments still store `divisionId=99`, `busLine=65`.
- Child shipment: `<parentFileNumber>-1`, `-2`, … A child created before its parent exists gets a normal number and is linked later.
- Quote: `600000 + n`. Invoice: `<fileNumber>-1`, `-2`, …

## "One place" services (extend these, don't duplicate)

| Concern | Module |
|---|---|
| Client create/find-or-create/search | `src/lib/clientService.ts` (`findOrCreateClient` always sets the role flag; never pass an address that equals the name, because the legacy app double-printed it on the BOL) |
| Business numbers | `src/lib/numbering.ts` |
| Money | `src/lib/money.ts` |
| Billable rollup + auto-invoice + Dry Run parsing | `src/lib/billing.ts` |
| Tracking timeline writes | `src/lib/tracking.ts` (`recordStatusChange` skips no-op re-saves) |
| Zoho → shipment mapping | `zohoMapping.ts` (pure, defensive multi-shape lookups, truncation caps) → `zohoShipmentSync.ts` |
| Zoho status ↔ enum | `src/lib/zohoStatusMap.ts`. Keep it in lockstep with the Prisma enum |
| Zoho layouts/forms | `zohoLayouts.ts` (6 layouts: Via Warehouse, Direct to Port, Dispatch to Warehouse, Dispatch to Port, Warehouse to Port, US Air Booking), `shipmentLayoutFields.ts` (column-backed vs generic `zohoFields`), `shipmentZohoSections.ts` |
| Outbound Zoho API | `src/lib/zohoDeskApi.ts`. `updateTicket` is the single write choke point, gated by `ZOHO_DESK_PUSH_ENABLED` |
| QuickBooks | `src/lib/qbo.ts` + `qboBackgroundSync.ts` (interval started from `src/instrumentation.ts`, nodejs runtime only) |
| Mail | `src/lib/mailer.ts`: Graph → SMTP → console log |
| PDFs | `src/lib/pdf/` (`renderToPdf.ts` + `templates/index.ts` registry: bol, booking-confirmation, dock-receipt, master-bl, container-load-plan; plus quote and pickupBol) |
| Pickup BOL | `src/lib/pickupBol.ts`. Dispatch shipments only; never issued with blank required fields |

## Zoho Desk integration (the main data entry path)

- Webhooks: `POST /api/webhooks/zoho/ticket-created` and `/ticket-updated`. Auth is the `x-zoho-webhook-secret` header **or** `?secret=`. They **must always return 200**; failures go on the `ZohoSync` row. Zoho sends an empty `{}` on URL validation, which is ignored. The body is `[{ payload, eventType, prevState? }]`.
- Race safety: `claimShipmentCreationForTicket` writes a sentinel into `ZohoSync.fileNumber`. Always test it with `isPendingCreationClaim()`, never `!fileNumber`. `claimRecreationForTicket` handles "shipment was deleted".
- ticket-updated re-resolves Shipper/Consignee/Account when Origin/Destination/Account changes (a legacy bug fix). It maps status (unknown statuses are ignored), merges layout fields, records the tracking event, auto-creates the invoice if newly eligible, syncs invoice amounts, and refreshes the Pickup BOL.
- Shipper/Consignee fall back to the Origin/Destination text when `cf_shipper`/`cf_consignee` are empty. Resolution is by name only, with no address.
- Parent/child is **Sky2C only** (Zoho org `60028198741`), overridable via `ZOHO_PARENT_CHILD_ENABLED`; Vhaul4u stays flat. Webhooks never carry the parent link, so it's read back through the API (`getTicketWithRelationship`, `listChildTicketIds`). A child takes the parent's account and is **never invoiced**.
- Push-back: the file number goes into the ticket's "Reference Number". Its real API name is `cf_pickup_country` (relabeled field), configured via `ZOHO_DESK_REFERENCE_NUMBER_FIELD` with no default on purpose. This was silently off from 2026-08-07 because `ZOHO_DESK_PUSH_ENABLED` defaulted to false.
- Reply-all "file generated" notice exists only for accounts named `SKY2C` / `SKY2C ECOM` (matched by name), gated by `ZOHO_DESK_REPLY_ENABLED`. The SMTP order-confirmation email was disabled 2026-08-20 (`ORDER_CONFIRMATION_EMAIL_ENABLED`).
- Zoho quirks (confirmed live): a ticket with zero attachments returns **404**; attachment download needs the `/content` suffix; the Self Client token lacks the mailReplyAddress scope, so use `ZOHO_DESK_REPLY_FROM_ADDRESS`; after a failed token refresh, back off or Zoho locks the refresh token.
- Customer-visible attachments are filtered by filename prefix (`isCustomerVisibleAttachment`, e.g. `BOL_SIGNED…`). The tracking page is public, so never default to showing everything.
- Open TODO: confirm the real API name of the "BOL Number" custom field (`zohoMapping.ts`), and the parent-ticket key in a real child payload (`resolveTicketHierarchy`).

## Billing and QuickBooks

- An invoice is auto-created once when the shipment has an amount and an Account **and** reaches PICKED_UP, DELIVERED or ON_HAND (not ON_HOLD). The default charge code is `TRK`. It never throws.
- Dry Run: each line `<amount> - <description>` in `dryRun` becomes an `ArInvoiceLineItem`, plus a final quote-amount line. **Total = sum of all lines.** Dates are stripped before amount parsing. Unparsable lines are skipped and logged.
- `billableStatus` rollup priority is POSTED > IN_PROGRESS > CANCELLED > DELETED, else NOT_APPLICABLE. Call `recomputeShipmentBillableStatus` after **any** invoice status change.
- Invoice actions: post / adjust / reverse / cancel under `/api/invoices/[id]/*`.
- QBO: a single realm. `ensureCustomerInQBO` matches by DisplayName. Every line posts to the one Item mapped as default ("Trucking"); a missing mapping fails loudly. Signed BOL attachments from Zoho are attached to the QBO invoice. A background interval retries POSTED-unsynced invoices. An expired refresh token needs an interactive reconnect at `/api/quickbooks/connect`.

## Gotchas and rules

- **Code comments (user rule, 2026-11-19):** short, simple one-line comments written the way a person would, no paragraph or multi-line doc blocks. Say what or why in a few words; long explanations go here. The AES files were rewritten this way (only comments changed, code checked identical with comments stripped).
- **AES WebLink in Chrome vs Edge (found 2026-11-16):** in the user's Chrome, every TMS → AESDirect filing landed on the ACE portal (`ace-test.cbp.gov/s/`), and fields only pre-filled on a second Confirm right after launching Submit AES Filing. **Edge works first time.** The cause was a Chrome-side setting or profile difference, most likely blocked third-party cookies (or a different profile/Incognito); after the user changed it, Chrome worked. Neither TMS nor CBP needed a fix. Users are told to use Edge on the AES page. If Chrome is needed: one normal (non-Incognito) profile for TMS and ACE, and allow third-party cookies for `[*.]cbp.gov` and `[*.]cbp.dhs.gov`.
- **After any `prisma/schema.prisma` change, stop `npm run dev` and run `npx prisma generate` (then `npx prisma db push` for new collections/indexes) before restarting.** `next dev` doesn't type-check, so a stale client only fails at runtime. Seen 2026-11-05: Sabastin's local client was still generated from the Oct 21 schema, `prisma.aesSubmission` didn't exist, and every AES hand-off failed with "Couldn't record this hand-off in the TMS audit log, so nothing was sent to CBP" (fail-closed by design). On Windows, `generate` can't replace `query_engine-windows.dll.node` while the dev server holds it, so stop the server first. QA's deploy runs `prisma generate` itself, but not `db push`.
- "Best-effort, never throw" is deliberate for every side effect after a shipment write (Zoho push-back, reply, tracking event, auto-invoice, QBO sync, BOL). Keep it that way.
- Never mutate live Zoho from dev. Every write goes through `updateTicket`, which is gated.
- Truncate all Zoho free text before persisting (`MAX_TEXT_LEN` 500, Dry Run 4000).
- Branding is Vhaul4u-derived (navy/red/teal). `package.json` name is still `domestic-warehouse-tms`.
- Secrets: never commit `.env`. Share credentials via a secret store, not Teams.
- **Line endings: the working tree is CRLF throughout** (Windows). Keep CRLF when editing or creating files. An editor or script that rewrites a file as LF turns the whole file into a git diff (this happened to `.env.example` once and was reverted).
- Building in a sandbox without internet: `src/app/layout.tsx` loads Geist via `next/font/google`, so `next build` fails if Google Fonts is unreachable. Mock it with `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=<file exporting {url: css}>`. `prisma generate --no-engine` gives types without the engine download.

## AES / CBP export filing (stage 1 built: mapping + audited hand-off to CBP staging)

**Built 2026-10-22, reviewed and refined 2026-10-23; audit log built 2026-11-05 (two additive AES audit models, see below); full field mapping + AES details form built 2026-11-18 (adds `ShipmentAes` and the `DETAILS_SAVED` event type):**
- The AES button next to Save (`ShipmentForm.tsx`) links to `/shipments/<fileNumber>/aes` for saved shipments. All TMS shipments are eligible, and Sky2C files as forwarding agent.
- `src/lib/aes/weblinkFields.ts` is a PURE mapper from shipment + parties + cargo to WebLink fields. It also builds a per-field report (`mapped` / `derived` / `missing` / `not-in-tms` / `warning`) and shipment-level `advisories`.
  - Sources: USPPI = shipper (falls back to account); ultimate consignee = consignee (falls back to shipTo); forwarding agent = Client `AES_FORWARDER_CLIENT_ID` + `AES_FILER_ID`; lines = CargoItems (falls back to `cargoDescription`); EQ/SN = containers.
  - Derived and flagged "confirm": MOT (from domesticType/layout) and FO=`2` (predeparture, the AESDirect default; option 4 needs CBP approval).
  - Values TMS doesn't store (EIN, SCAC, Schedule B, EIC, license, origin D/F, RCC/HAZ/RT, consignee type, sold-en-route, VIN, …) come from the **AES details** form (2026-11-18, below). If not entered they are **left blank, never faked**, and the user completes them in AESDirect.
  - Advisories: destination resolves to US; Canada (FTR 30.36, usually exempt); total value ≤ $2,500 (FTR 30.37(a), possibly exempt); USPPI with a non-US country.
- **SRN = `toSrn(fileNumber)`.** AES allows 1–17 alphanumerics only, so a child's dash becomes `C` (`101060000-1` → `101060000C1`). An SRN is never reused for another shipment: corrections resend the same SRN with **FAC=R** (Census), and AES rejects an Add for a used SRN. The page has an Add/Replace choice and pre-selects Replace once CBP has returned an ITN.
- `src/lib/aes/codes.ts` normalizes values:
  - All values pass through `toAesText` (ASCII, accents transliterated).
  - Contact names go through `toAesPersonName` (no punctuation/accents, ≥2 letters, per AESDirect).
  - US phone drops a leading 1; US ZIP becomes 5 or 9 digits.
  - State → 2-letter code (sent only for US/CA/MX parties); country → ISO-2 (via `Intl.DisplayNames`).
  - Each returns "" when unsure.
- `src/lib/aes/aesHandoff.ts` loads the records. Port codes come only from `Location.code` when it matches Schedule D (4 digits) or K (5 digits). It also builds the status-inquiry fields (`FID`, `SRN`, `URL`; URL only when the app base URL is https).
- `src/lib/aes/config.ts`: **CBP cert/staging by default** for both filing and inquiry.
  - Production requires `AES_ENVIRONMENT=production`, both `AES_WEBLINK_FILING_URL` and `AES_WEBLINK_INQUIRY_URL` set explicitly (non-cert), and `NODE_ENV=production`. QA builds with NODE_ENV=production, so there the explicit env vars are the guard.
  - A non-cert URL is refused while in cert. The filer ID is normalized and validated (9–11 alphanumerics).
  - Missing filer ID or forwarder client shows a setup warning.
- `src/app/shipments/[fileNumber]/aes/` is the server page:
  - Page order: (LIVE warning only in production), status card, CBP result banner, compliance advisories, "How to file" list, **AES details form**, action row, details table, audit history.
  - **User-facing wording (refined 2026-11-16, keep it this way).** Short plain-English bullets, no paragraphs.
    - **No field codes or technical terms in the page text or the popup:** no SRN, COD, EDA, FID, WebLink, USPPI, EEI, FTR, env var names, "hand-off", "audit log" or "staging"; and no "→" arrows.
    - **Plain terms used instead:** "CBP reference" (the SRN), "ITN (export filing number)", "Test mode" / "LIVE", "New filing (Add)" / "Correction (Replace)", "Goods lines".
    - Technical detail stays in the audit (event `detail`, the AES Audit page) and in server logs.
    - A Playwright check scans 9 page states and the popup for banned terms (regex in the status UI test script). The AES audit history panel is exempt: it's an audit tool and still shows raw summaries and "Show fields".
    - **Banner (changed 2026-11-16 at the user's request):** **no banner in test mode**, on the page or in the popup. Only production shows the red "LIVE: filings go to CBP and are official export filings." (popup: "LIVE: this is an official export filing."), kept on purpose as a safety guard. Buttons still read "Open in AESDirect (test|LIVE) — Add|Replace".
    - **"How to file" (2026-11-16): ONE short list, single-line bullets, no columns or sub-headings:** Use Microsoft Edge · Sign in to the ACE test portal and open Accounts > Exporter > Submit AES Filing; keep it open · Choose Add (new) or Replace (correction) · Click Open in AESDirect, then Confirm · In AESDirect, complete the filing and click Submit Filing · Sign-in page opens? Sign in, open Submit AES Filing, click Confirm again · Need help? AES help desk email/phone. Each bullet fits on one line at desktop width (Playwright-checked).
    - **CBP result banner:** a plain title; bullets for Status (Accepted/Rejected + raw text), ITN, a reference mismatch, and "✓ Saved in TMS (sent by …)" or "Unverified: not matched to a filing sent from TMS". The raw CBP parameter list is no longer shown (it's in the audit).
    - **Config problems:** plain disabled reasons only ("AES filing isn't set up correctly / is turned off / Status checks aren't set up yet. Ask your administrator."). **Config warnings (missing AES_FILER_ID / AES_FORWARDER_CLIENT_ID) are no longer shown on the page at all** (removed 2026-11-16; an admin issue). The `configWarnings` prop is kept but unused; they still reach the audit via hand-off advisories. Fix them by setting both env values (the old app used Sky2C EIN 943355318, to be confirmed).
    - **API refusals:** `handoffRequest.ts` `USER_MESSAGE[reason]` returns plain messages to the browser, while the audit event keeps the technical message. The 503 messages say "Couldn't save this step in TMS, so nothing was sent to CBP …".
    - **Details table:** headed "Details sent to AESDirect"; columns Item / Value sent / Taken from / Status (no code column); section names via `groupLabel()` (Exporter, Consignee, Sky2C (filing agent), Goods line N, Containers); status chips Filled from TMS / Please confirm / Please check / Missing in TMS / Fill in AESDirect.
    - **Mapper text (`weblinkFields.ts`), labels/sources/advisories only:** sources no longer name env vars (e.g. "TMS settings (Sky2C filer ID)", "Sky2C client record (ID)"), and the advisories are plain ("Destination is Canada. Most exports to Canada don't need an AES filing …"). **Field codes, values, statuses and counts are byte-identical**, checked old vs new on 3 scenarios.
  - **Confirmation popup (added 2026-10-26, like the legacy `ConfirmAESSubmissionPopup`).** "Open in AESDirect" is a `type=button` that only opens a native `<dialog>` (`showModal`). There is **no hand-off `<form>` in the page** any more: only the dialog's "Confirm & open AESDirect" sends anything, through the audited hand-off (below).
    - **The popup** ("Send this filing to CBP?") shows: Test/LIVE banner, File no., CBP reference, Type (New filing (Add) / Correction (Replace)), Destination, Export date, Goods lines, Left to fill in, any warnings (already accepted → choose Replace; Replace without an accepted filing → choose Add; no goods), then bullets (stay signed in, use Edge; opens pre-filled; nothing is filed until Submit Filing; sign-in page → sign in, open Submit AES Filing, Confirm again). The Confirm button shows "Sending…" while the step is saved.
    - Production adds a required "I understand this is a real export filing" checkbox, which resets on every open. Cancel and Esc send nothing.
    - The `<dialog>` needs `m-auto`, because Tailwind's preflight removes the browser's centering margin.
    - Verified with Playwright (22 checks 2026-10-26, plus 37 audit-flow checks 2026-11-05; CBP requests intercepted, `/api/aes/handoff` mocked). To re-test, render `AesHandoffClient` (+ `AesAuditPanel`) with fixture props on a scratch page under a public prefix (e.g. `/tracking/aesdemo`) in `next dev`, and never commit that page. After deleting it, `rm -rf .next` or `tsc` fails on a stale `.next/dev/types` entry.
  - The steps panel and the dialog link the sign-in site for the configured host: `config.portalUrl = portalUrlFor(filingUrl)`. A `trade-test.` host (today's default) links the ACE Certification portal `https://ace-test.cbp.gov/` (`ACE_TEST_PORTAL_URL`, labelled "CBP certification (test) ACE Portal"); a `.crt.` host links its own site; production links the modernized `https://ace.cbp.gov/`. In staging the panel also shows the AES help-desk contact. The old session-broker step was removed (its URL is dead).
  - Layout: the status-count chips sit on one row. The actions sit on their own row below it, **right-aligned** (`justify-end`): the Add/Replace choice and "Open in AESDirect" (audited filing, POST in a new tab) as the rightmost button. Keep the actions on that separate row, because sharing a row with the chips made the button drop to the left when the row wrapped. "Check status with CBP" moved out of this row into the status card on 2026-11-05 (see below); there is exactly one such button.
  - Shows CBP's returned params; validates the ITN format (`^X\d{14}$`) and flags an SRN mismatch. The banner says **verified** when the return's nonce (`aes_n`) matches a recorded hand-off for this shipment, otherwise **unverified**. Replace is pre-selected when the URL carries a valid ITN or any recorded CBP return (filing or status check) has one (`statusSummary.itn`).
  - `AesAuditPanel.tsx`: collapsible "AES audit history" (newest first, UTC, read-only): event, who, env, summary, outcome/ITN, and for each filing the exact posted fields with a diff against the previous filing (`src/lib/aes/auditDiff.ts`). Warns when a hand-off has no CBP return after 24 h (computed). If the audit can't be loaded the page still works and says so.
- **CBP return routes** (outcome = success | failure | status), both **PUBLIC in middleware** via the `/api/aes/return` prefix (a cross-site POST carries no Lax cookie and an expired session must not lose the result):
  - The data is in the PATH so CBP can safely append `?SRN=…&ITN=…&STA=…`.
  - Handles GET and POST (form body). It is **PUBLIC in middleware**, because a cross-site POST carries no Lax cookie and an expired session must not lose the result.
  - Nonce-less `src/app/api/aes/return/[outcome]/[fileNumber]/route.ts` (original, **unchanged**): no DB access, only 303s to the AES page with `cbp_*` params. Kept for hand-offs made before the audit log; their results show as unverified. Delete it, and the `weblink/return` shim, once the logs show no nonce-less returns for 30 days.
  - Audited `src/app/api/aes/return/[outcome]/[fileNumber]/[nonce]/route.ts` (logic in `src/lib/aes/returnRoute.ts`): writes to the audit only when the nonce matches a submission with the same file number and kind (status ↔ INQUIRY, success/failure ↔ FILING), at most 5 writes per submission (first sets the outcome, the rest are `CBP_RETURN_REPEAT`). Unmatched returns are console-only. The 303 is built the same way matched or not (`aes_return`, `aes_n`, `cbp_*`), so it reveals nothing, and a DB failure never blocks it.
  - `src/app/api/aes/weblink/return/route.ts` is a compat shim for the first build's `?fn=&o=` URLs. Delete it once no such filings can be in flight.
- Middleware keeps the query string in `from` when redirecting to login. The login page now only follows `from` values that are in-app paths, which closes a pre-existing open redirect.
- Env (all optional, none secret): `AES_ENABLED`, `AES_ENVIRONMENT`, `AES_WEBLINK_FILING_URL`, `AES_WEBLINK_INQUIRY_URL`, `AES_FILER_ID`, `AES_FORWARDER_CLIENT_ID`, `AES_NOTIFY_EMAIL`.
  - **WebLink API URLs are set in source in two places, which must stay identical:** the constants `CBP_CERT_FILING_URL`/`CBP_CERT_INQUIRY_URL` in `src/lib/aes/config.ts` (the built-in default, used when the env var is empty), and the values of `AES_WEBLINK_FILING_URL`/`AES_WEBLINK_INQUIRY_URL` in `.env.example`. Both are currently the CBP test/training URL `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/{createWeblinkFiling|weblinkFilingInquiry}` (official, provided by Sky2C 2026-10-26). When CBP supplies the working URL, update both, and copy the two lines into each environment's `.env` (local and `C:\Apps\tms-qa\.env`; the deploy never copies `.env`). An older line in a `.env` overrides the default.
  - Claude must not read or edit `.env` (it holds live credentials; the user declined access on 2026-10-26). Hand `.env` changes to the user as lines to paste.
- **Footprint on existing code.** AES touches exactly these pre-existing files: `src/components/ShipmentForm.tsx` (AES button only), `src/middleware.ts` (two public prefixes + `from` keeps the query), `src/app/login/page.tsx` (`from` must be an in-app path), `.env.example` (AES block appended). Everything else is new under `src/lib/aes/`, `src/app/api/aes/` and `src/app/shipments/[fileNumber]/aes/`. No Prisma schema change, no DB writes. Nothing outside the AES files imports `src/lib/aes`. **Audit log (2026-11-05) adds:** `src/components/NavLinks.tsx` (one nav entry), `prisma/schema.prisma` (models appended; existing bytes untouched), and inside AES files only `aesHandoff.ts` (optional nonce; `shipmentId`/`fieldsHash` added to the result), `page.tsx`, `AesHandoffClient.tsx`. Middleware, the login page, `ShipmentForm.tsx`, `package.json`/lockfile and the original return route are unchanged.
- **Regression check 2026-10-23:**
  - The original vs new middleware gave identical results on 21 existing flows: staff and customer pages/APIs with and without sessions, Zoho and QBO webhooks, tracking, `_next` assets, and look-alike paths such as `/api/aesx` (still protected). Only the two intended changes differed.
  - All `from` values the app generates still pass the login check.
  - `tsc --noEmit`, ESLint and a full `next build` passed, with every existing route and the three AES routes compiled.
  - Re-run that middleware comparison whenever middleware changes.
- Verify on the first cert run:
  - the return parameter names (legacy read `SRN`/`ITN`/`STA`);
  - that the official trade-test URLs work once Sky2C has a CBP test account (the older published test URLs all failed; see below);
  - whether CBP returns via GET or POST.
- **AES audit log (built 2026-11-05).**
  - **Models** (additive, end of `prisma/schema.prisma`): `AesSubmission` (one per hand-off: unique `nonce`, exact `payload`, `payloadHash`, actor snapshot, `outcome` set once) and `AesAuditEvent` (immutable: `FILING_HANDOFF`, `INQUIRY_HANDOFF`, `HANDOFF_BLOCKED`, `HANDOFF_STALE`, `CBP_RETURN`, `CBP_RETURN_REPEAT`; `ITN_CONFIRMED`/`ITN_ENTERED_MANUALLY`/`MARKED_EXEMPT` reserved). Soft refs only, no `@relation`, no cascade, no TTL (keep ≥ 5 years, 15 CFR §30.10).
  - **Rule: only `src/lib/aes/audit.ts` reads or writes these collections.** There is no update/delete of an event anywhere; `AesSubmission` changes only via the two guarded `updateMany` calls in `recordReturn` (capped `returnCount`; outcome while still `PENDING`). Check with `grep -rn "aesAuditEvent\.\(update\|delete\|upsert\)" src` (must be empty) and `grep -rln "aesAuditEvent\|aesSubmission" src` (only `audit.ts`).
  - **Fail-closed hand-off:** Confirm (or "Check status") opens the new tab *inside the click* (`window.open("", name)`, `opener = null`) so it isn't blocked, then calls staff-only `POST /api/aes/handoff` (`src/app/api/aes/handoff/route.ts` → `src/lib/aes/handoffRequest.ts`). That rebuilds the fields server-side via `buildAesHandoff(…, { nonce })`, refuses with 409 + `HANDOFF_BLOCKED` (AES off, config error, production without the ack, inquiry without filer ID) or `HANDOFF_STALE` (page-render `fieldsHash` ≠ server rebuild), writes `AesSubmission` + event in one `$transaction`, and returns the exact fields. Only then does the browser post them to CBP in that tab. Any failure (API 4xx/5xx, network, pop-up blocked) closes the tab and shows the error; nothing reaches CBP. JSON-only (415 otherwise).
  - `fieldsHash` = sha256 of canonical JSON of the field map without `wl_success_url`, `wl_nosed_url`, `URL`, `FAC`. Nonce = 16 random bytes, base64url (22 chars), placed in the return URL path by `aesReturnUrl(base, outcome, fn, nonce)`. Without a nonce, `aesReturnUrl` builds exactly the old URLs, so the page render is unchanged.
  - Every write is also logged as `[aes-audit] {json}` (no payload). Unmatched returns are logged with an IP hash only.
  - **Views:** the per-shipment panel above, plus staff-wide `/aes-audit` (nav "AES Audit", after Zoho Sync): filters for file #, event, environment, user email (case-insensitive, regex-escaped), UTC date range; 50 per page; CSV via `GET /api/aes/audit?format=csv&…` (≤ 10,000 rows, formula-injection safe). All staff can see it (no roles exist).
  - **Deploy:** after pulling this, run `npx prisma db push` once per database (local and QA `qa-tms-sky2c`); the QA deploy does not run it. It only adds two collections and their indexes (the unique `nonce` index matters). Until it has run, the inserts still work, but nonce uniqueness isn't enforced.
  - **Checks 2026-11-05:** 72 scripted checks against an in-memory fake DB (hashing, nonce, every API branch incl. fail-closed rollback, every return case incl. cap and kind mismatch, filters, CSV, diff); 37 Playwright checks; 12 middleware path checks (new APIs 401, `/aes-audit` → login, nonce route public, look-alikes protected); real HTTP checks on `next dev` with no DB (return routes still 303, hand-off API → 503 JSON, CSV → 503); `tsc`, ESLint and a full `next build` pass. The nonce-less return route and the shim were confirmed to behave exactly as before.
  - **Not done on purpose:** Vitest wasn't added. `npm install -D vitest` rewrote 40 existing `package-lock.json` entries, which would change installs on QA and Docker. Checks stay as scratch scripts (fake-DB DI: every `audit.ts` writer takes an optional `db`, and `handoffRequest`/`returnRoute` take injectable deps).
- **CBP status check — built 2026-11-05.**
  - **How CBP's WebLink Status API works:**
    - It is a **browser hand-off**: the user must be signed in to ACE in the same browser.
    - Request: `FID` (filer ID, ≤ 11), `SRN` (≤ 17), and optionally `URL`, an **https** return address.
    - CBP redirects back with GET `?FID&SRN&STA&ITN`. `STA` is CBP's "AES Status Description" (values unpublished); `ITN` is sent if available. Without a return URL, CBP shows the result in its own tab.
    - **No server-side or background polling:** AESDirect forbids storing user credentials in third-party apps. A background check would need ACE ABI/EDI.
  - **Test URL:** `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry` (already `CBP_CERT_INQUIRY_URL` / `.env.example`).
  - **UI — `AesStatusCard.tsx`, under the environment banner and above advisories/steps on the AES page:**
    - The shipment's **latest known CBP status from the audit**, shown on every load as plain bullets: chip Accepted / Rejected / Submitted, no status yet / Not filed / See CBP status / Not checked yet; "CBP says: <raw STA>", "ITN (export filing number)" (an earlier one is flagged "from an earlier result"), and "Last checked / Last filing <UTC> by <name>". Also "Waiting for CBP's answer …" or "No answer from CBP after 24 hours", and the CBP reference. Since 2026-11-16 the filer ID and "matched to a recorded hand-off" are no longer shown.
    - Also shows "Waiting for CBP's answer…" for a newer pending check, "No answer … after 24 hours" for a stale one, SRN, and FID.
    - **The "Check status with CBP" button is always visible.** It is disabled with a plain reason: "AES filing is turned off", "AES filing isn't set up correctly" or "Status checks aren't set up yet" (all "Ask your administrator"), or "Please wait, a filing is being sent". Technically these mean AES_ENABLED=false, a config error, or AES_FILER_ID missing (CBP requires FID). It reads "Checking…" while busy.
    - Without an https `APP_BASE_URL` it says "CBP will show the result in its own tab."
    - The click is the unchanged audited `runHandoff("INQUIRY")`: tab pre-opened → `POST /api/aes/handoff {kind:"INQUIRY"}` → GET to CBP. API errors show inside the card.
  - **Logic — `src/lib/aes/aesStatus.ts`** (pure, client-safe, type-only import from `audit.ts`):
    - `decodeSta`: "R" / contains REJECT / NOT ACCEPT → REJECTED; "A" / ACCEPT… → ACCEPTED; other text → OTHER; blank → UNKNOWN. This is the legacy A/R rule. **Record the real STA texts from the first CBP test run here.**
    - `summarizeAesStatus(submissions)`: the newest returned submission of either kind. Without STA, a FAILURE filing return → FAILED, and SUCCESS → ACCEPTED if there's an ITN, else SUBMITTED. Also returns the newest valid ITN, a pending inquiry newer than the latest return, and the last filing.
    - `page.tsx` passes `statusSummary` (null if the audit couldn't load) and `filerId`. **No new queries**: it uses the submissions already loaded by `getShipmentAudit`.
  - `audit.ts` `recordReturn` now keeps `staReported` up to **200** chars (was 20). Existing rows are unaffected.
  - **Footprint:** new `AesStatusCard.tsx` and `aesStatus.ts`; changed only `AesHandoffClient.tsx` (props `latestFiling` → `statusSummary` + `filerId`; inquiry button moved into the card), `page.tsx` and one line of `audit.ts`. No schema, route, middleware, config, `aesHandoff.ts`, `ShipmentForm.tsx` or package change, and no `db push`.
  - **Checks 2026-11-05:**
    - 23 scripted status checks (`decodeSta`, every summary case, STA 160 chars kept / 250 → 200).
    - The 72 audit checks re-run and pass.
    - 23 new Playwright checks: placement, one button, every state, every disabled reason, the http note, a GET to trade-test with FID/SRN/nonce URL, API refusal closes the tab, no hydration errors.
    - The earlier 37 filing/audit Playwright checks re-run and pass.
    - Real HTTP on the status return routes (nonce and old) still 303.
    - `tsc`, ESLint and a full `next build` (same 91 routes) pass.
  - **To use it:**
    - `AES_FILER_ID` set.
    - An https `APP_BASE_URL` (the QA URL; locally a cloudflared/ngrok tunnel), or the result stays in CBP's tab.
    - The pending CBP test account, signed in to in the same browser.
  - Not built on purpose: a status badge on `ShipmentForm`/the shipment list (it would touch `ShipmentForm.tsx`), and manual "record status from the CBP screen" (reserved `ITN_ENTERED_MANUALLY`).
- **Full field mapping + AES details form (built 2026-11-18).** User choices: details entered **all on the AES page**; gate **"allow, but warn"**; verify on a real shipment exported from Compass.
  - `src/lib/aes/aesDetails.ts` (pure, client-safe zod): shipment overrides (filing option 2/4, mode, ports, booking/AWB/BOL, carrier code, vessel/carrier name), RCC/HAZ/RT, in-bond code + entry number, FTZ, original ITN, exporter ID + type, consignee type, sold en route, intermediate consignee (AD4), and per goods line (keyed by cargo item id, or `desc`): Schedule B, export info code, license type/number/value, ECCN, origin, two unit/quantity pairs, vehicle ID type + VIN, the 7 State Department (ITAR) items, EPA/AMS flags. All optional; formats checked only when filled; plain messages keyed by path (`lines.<key>.<field>`). Separators stripped from EIN/Schedule B; values upper-cased. `readAesDetails` is lenient (bad stored values reset per field).
  - `src/lib/aes/aesDetailsStore.ts`: `getAesDetails` **never throws** (logs `[aes-details]`, returns null, so a missing collection or stale client changes nothing); `saveAesDetails` upserts and records a best-effort `DETAILS_SAVED` audit event via `recordDetailsSaved` in `audit.ts` (detail = changed keys; label "AES details saved" in the audit panel).
  - `PUT /api/aes/details` (`src/app/api/aes/details/route.ts`): staff-only by middleware default, JSON only (415), session (401), file number check, ≤ 120 line keys, 400 `{error, fieldErrors}`, 404, 503 "Couldn't save the AES details…". Never contacts CBP.
  - `weblinkFields.ts`: takes optional `details`. **AES details override TMS** for MOT/POE/POU/BN/VN; BN also falls back to Zoho `cf_awb` after BOL/PRO; new rows IBT/IBN/FTZ/ORIG_ITN, AD4_*, IT_3/5/6/9/10/16/20, ODTC_1–7, EP_1/AMS_1. Result adds `lines: [{key, description, vehicle}]`. `aesHandoff.ts` loads the details (and `cf_awb`) and returns `details`; item ids are passed so lines key correctly.
  - **No impact without details:** fields, CBP reference, line count, counts and advisories are byte-identical to before (old vs new on 3 scenarios); new rows are empty, not required, hidden. The hand-off/`fieldsHash` path is unchanged (details are part of the server rebuild, so saving details then sending from an old page gives the normal "page changed, reload" stale refusal).
  - `AesDetailsForm.tsx` (client, via `detailsSlot` prop of `AesHandoffClient`): collapsible "AES details", open when required items are missing, badge "N required items missing" / "All required items filled", "Last saved … by …"; sections Shipment / Exporter / Consignee / Intermediate consignee (collapsed) / Goods lines (each with a collapsed "State Department (ITAR) items"); TMS values as grey placeholders; VIN only on vehicle lines; "Fill usual values (OS, C33, made in US, no EPA/AMS)" fills **empty boxes only** (flags N, filing option 2, vehicle ID V); Save → PUT → `router.refresh()`. No field codes on screen.
  - Popup: "Required items missing" shows "None, ready to submit" or the count, plus "Still missing (fill in AES details, or in AESDirect):" with up to 6 plain items and "and N more". Sending stays allowed.
  - Not mapped on purpose: AD4_14 (legacy "R", meaning unconfirmed), FT (unused by legacy), EP_2–5 / AMS_2 (legacy placeholders). ODTC_6 position unconfirmed (note on the row).
  - **Deploy:** stop dev → `npx prisma generate` → `npx prisma db push` (local and QA). Until then reads return "no details" and Save returns the 503 message; everything else works as before.
  - **Checks 2026-11-18:** full-shipment mapping (14: 0 required missing, 117 fields, values normalised), store/validation (10), the 72 audit + 23 status + mapper checks, 34 new Playwright checks on the form and popup (placement, open/closed, badge, saved values, fill-usual, PUT body, field errors, 503/network, no technical terms, phone width, page works without the form), the 40 status + 37 audit Playwright checks; `tsc`, ESLint and a full `next build` (new route `/api/aes/details`) pass.
- **Airline e-AWB — planned 2026-11-16, not built:** Sky2C uses about 25 airlines, about 10 support e-AWB. e-AWB means sending the air waybill electronically ((X)FWB, plus (X)FHL/XFZB for consolidations; Cargo-XML preferred) under the IATA Multilateral e-AWB Agreement (sign once; per-airline, per-airport activation). Airlines answer FMA (ok) / FNA (error), then FSU FOH (contract concluded) / RCS (ready for carriage) and flight milestones, so the loop can be closed. It depends on AES: the AWB must carry the AES proof of filing (ITN) or an exemption legend (15 CFR 30.7), given to the carrier at least 2 h before departure (30.4). **Not covered today:** the new TMS has only free-text Zoho `cf_awb`/`cf_hawb` and a carrier picklist; the old app printed laser AWBs and had no e-AWB messaging. Plan: an `Airline` master (IATA code, prefix, e-AWB per airport), `AwbStock` (check digit = serial mod 7), `AirWaybill`, and an append-only `AwbMessage`. Send through a messaging hub (provider adapter, ONE Record-ready) gated on an accepted AES ITN; inbound webhook at public `/api/eawb/inbound`; FSU milestones into `ShipmentTrackingEvent`. Manual airlines get a printed AWB with the ITN. About 20–28 dev-days in phases 1–4, plus business prerequisites (MeA, activations, provider, AWB stock, TSA IAC/e-CSD).
- Next steps: (`ShipmentAes` is built 2026-11-18; optional later: a reusable Schedule B / client EIN lookup so details aren't retyped per shipment), "Confirm ITN" / manual ITN entry / mark exempt (write the reserved event types through `audit.ts`), and print the ITN on documents.

Key facts so nobody re-derives them:
- The legacy app (and this TMS) use **CBP ACE AESDirect WebLink**. It is a browser hand-off, not a server API:
  - Our page auto-POSTs hidden EEI fields (`SRN`, `FAC`, `POE`, `AD0_*` USPPI, `AD1_*` ultimate consignee, `AD3_*` forwarding agent, `ITX_*` commodity lines, `EQX/SNX`, …) to `createWeblinkFiling` in a new tab.
  - The user must already be signed in to the ACE Portal → AESDirect in that browser, reviews the pre-filled filing and submits it inside AESDirect.
  - CBP redirects the browser to `wl_success_url`/`wl_nosed_url`. The legacy app read `SRN`, `ITN`, `STA` (A=accepted, R=rejected); confirm these names in cert.
  - Status is re-fetched via `weblinkFilingInquiry?FID&SRN&URL` (https URL only).
- No CBP credentials are stored. The return redirect is untrusted: correlate it with the per-submission nonce (built 2026-11-05: `recordReturn` in `audit.ts`), check `SRN` = `toSrn(fileNumber)` and the ITN regex `^X\d{14}$`, and keep it "reported" until confirmed.
- WebLink `FAC` supports only **A** (add) and **R** (replace). Cancellation happens inside AESDirect. The legacy `FAC=X` is unverified.
- CBP WebLink URLs (official, from CBP's "AESDirect WebLink Inquiry API" page, provided by Sky2C 2026-10-26):
  - **Test/training (default):** filing `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling`, status `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry`.
  - **Production:** filing `https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling`, status `https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry`. Never a default; needs `AES_ENVIRONMENT=production` + both `AES_WEBLINK_*` set explicitly + `NODE_ENV=production`.
  - **Sign-in:** test → ACE Certification portal `https://ace-test.cbp.gov/` (CBP "Submitting WebLink" v2.0, Sep 2023); test AESDirect home is `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/home` (orange "TRAINING ENVIRONMENT" banner). Test logins go through CBP's sandbox IdP `cbplogin--sat.sandbox.my.site.com` (seen 2026-10-26) and need a CBP-issued test account; production ACE credentials don't carry over. Test status emails come from DoNotReplyTest@cbp.dhs.gov. Production → modernized ACE Portal `https://ace.cbp.gov/` → Accounts → Exporter → "Submit AES Filing" (CSMS #58166135). No session-broker step. The browser must be signed in on the same environment as the URL. Contacts: AES help desk askaes@census.gov (AES/WebLink); ACE Support ACE.Support@cbp.dhs.gov (ACE portal accounts/logins).
  - `isCertUrl()` recognizes `trade-test`, `/aesdc/`, `.crt.`, `/cert/` as test; anything else (incl. `trade.cbp.dhs.gov`) counts as production (fail-safe). QA must use test.
  - **Superseded, all failed 2026-10-26, don't reuse:** `https://ace.cbp.dhs.gov/aesdc/…` (CSMS #49999216; legacy Sky2CWeb used it) → Akamai "Internal Server Error" (ref #3.3f4a3917.1793028167.3a664321); `https://ace.crt.tnc.ace.cbp.dhs.gov/nace/…` → DNS NXDOMAIN; `https://ace.cbp.dhs.gov/nace/…` (old prod); `/aesd/ta/cert/aes-direct/…` + `sessionBroker` → proxy "Server Error".
  - **Status (2026-10-26), blocked on CBP test credentials.** TMS side is done: trade-test filing/status URLs, sign-in link → `https://ace-test.cbp.gov/`. Opening the test site lands on CBP's sandbox login (`cbplogin--sat.sandbox.my.site.com`), and Sky2C has no test-environment account (production ACE logins don't work there).
    - **Next step (user):** email the access request **To: askaes@census.gov, Cc: ACE.Support@cbp.dhs.gov**. Asks: (1) an ACE test/certification account for Sky2C (ace-test.cbp.gov), (2) AESDirect WebLink filing + inquiry enabled on it, (3) the parameter names WebLink returns to wl_success_url / wl_nosed_url. Include Sky2C's EIN (filer ID), ACE user ID and contact. A draft was given to the user 2026-10-26 (not sent by Claude); it also cites the old `/aesdc/` Akamai ref #3.3f4a3917.1793028167.3a664321.
    - **Once credentials arrive:** sign in at ace-test.cbp.gov → confirm test AESDirect shows the orange "TRAINING ENVIRONMENT" banner → in TMS, shipment → AES → Open in AESDirect → Confirm → check pre-fill, submit, check the return page params and the email from DoNotReplyTest@cbp.dhs.gov. Then record the real return parameter names here and adjust `AesHandoffClient` (ITN/SRN/status display) if they differ from SRN/ITN/STA.
  - Contacts: AES help desk askaes@census.gov / 1-800-549-0595 opt 1 (AES, WebLink enablement, URLs); ACE Support ACE.Support@cbp.dhs.gov (ACE portal accounts, test/cert logins). If CBP moves the URLs again, set `AES_WEBLINK_FILING_URL`/`AES_WEBLINK_INQUIRY_URL` and update the constants in `config.ts` + `.env.example`.
- Don't copy legacy defects: hard-coded EMAIL, FID and forwarding-agent identity; placeholder EPA consent/tracking numbers on every line; mixed prod/cert URLs; `"CA - California"`-style values instead of bare codes.
- Models: `ShipmentAes` (1:1 with shipment) **built 2026-11-18** (line details live inside its `details.lines`, so no separate `AesCommodity`); still planned: `ScheduleB` (`AesSubmission` is built: the audit model, keyed by shipmentId/fileNumber, not by `ShipmentAes`). Planned `Client` fields: EIN/ID type/SCAC/IATA/state and country codes. Code goes in `src/lib/aes/*`, with `weblinkFields.ts` as a pure, unit-tested mapper.

## Scope vs. the legacy app

The legacy Sky2CWeb (308 ASPX pages, ~120 SQL Server tables) covered Ocean/Air import/export, AES, rates, full AR/AP/GL/cash/checks and reports. This repo covers **only** Domestic Warehouse shipments and quotes, AR invoicing (not AP/GL), QBO sync, clients/locations/lookups, Zoho Desk ingestion, PDF documents, customer portal and tracking.
