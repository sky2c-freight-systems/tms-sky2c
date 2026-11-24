# AES (CBP ACE AESDirect) — analysis and implementation plan

Status: **Stage 1 built 2026-10-22 and reviewed 2026-10-23.** It covers TMS→WebLink field mapping, hand-off to CBP staging, the status inquiry, an Add/Replace choice, and a public return route that displays CBP's result (see CLAUDE.md "AES"). §4 models / persistence are still planned. The AES button next to Save in
`src/components/ShipmentForm.tsx` opens `/shipments/<fileNumber>/aes`.

### Review 2026-10-23: gaps found in stage 1 and fixed
| Gap | Fix |
|---|---|
| SRN must be 1–17 **alphanumeric** (ACE AESDirect User Guide); child file numbers contain "-" | `toSrn`: dash → `C` (`101060000-1` → `101060000C1`), unique because top-level numbers are all digits |
| Always sent FAC=A; Census: corrections must resend the **same SRN as a Replace**, and AES rejects an Add for a used SRN | Add/Replace choice on the page; Replace is pre-selected when CBP returned an ITN |
| Filing option (FO) not sent or reported | FO=2 (predeparture, the AESDirect default), flagged "confirm" |
| Return URLs carried `?fn=&o=`, so CBP appending `?SRN=…` could produce a malformed URL | Path-based `/api/aes/return/<outcome>/<fileNumber>`; old URL kept as a shim |
| Return route only handled GET behind staff auth: a cross-site POST carries no Lax cookie, and an expired session dropped CBP's params | The route is public, handles GET and POST, has no DB access, and redirects to the authenticated page; middleware keeps the query in `from` |
| Login followed any `from` (pre-existing open redirect) | Only in-app paths are followed |
| No status check (the legacy app had "Get AES Status") | "Check status with CBP" → `weblinkFilingInquiry` (FID, SRN, https URL); `AES_WEBLINK_INQUIRY_URL` with the cert default |
| Non-ASCII text (é, curly quotes) could break the filing | `toAesText` on every value |
| AESDirect rejects punctuation/accents in contact names | `toAesPersonName` |
| US phone sent with country code 1; ZIP+4 with dash | US phone → 10 digits; ZIP → 5 or 9 digits |
| Foreign state names sent in the 2-letter state field | State only sent for US/CA/MX parties |
| Unvalidated filer ID | Normalized (dash removed) and validated as 9–11 alphanumerics, with setup warnings |
| No compliance hints | Advisories: US destination; Canada (FTR 30.36); total ≤ $2,500 (FTR 30.37(a)); non-US USPPI |
| Sold-en-route indicator not reported | Listed as "Enter in AESDirect" |
| Reported ITN not validated | ITN format check `^X\d{14}$`; SRN mismatch warning |
| No confirmation before contacting CBP (legacy had `ConfirmAESSubmissionPopup`) | Added 2026-10-26: a confirmation dialog summarising the filing; only Confirm posts to CBP; production also needs an explicit acknowledgement checkbox |
| "Unable to link to ACE" (2026-10-26) | Old `/aesd/ta/cert` + session broker retired; `/aesdc/` returned Akamai 500; `ace.crt.tnc` doesn't resolve. Switched to CBP's official `trade-test.cbp.dhs.gov` (test) / `trade.cbp.dhs.gov` (prod) URLs and the ace-test.cbp.gov sign-in link. **Blocked on a CBP test account:** request drafted 2026-10-26, to send To askaes@census.gov, Cc ACE.Support@cbp.dhs.gov (test login + WebLink enablement + return param names) |

## 1. What AES is, and what the old app actually did

AES (Automated Export System) is how Electronic Export Information (EEI) is filed with
CBP/Census for goods **leaving the US**. A successful filing returns an **ITN** (Internal
Transaction Number, `X` + 14 digits), which goes on the BOL/AWB. Purely domestic moves don't
file. In the old app, AES existed only for **Ocean Export** and **Air Export** files.

### The legacy integration is AESDirect **WebLink**, a browser hand-off, not a server API

| Legacy page | Role |
|---|---|
| `ManageShipmentAES.aspx(.cs)` | Header form per file (`tbl_shipmentaes`), commodity grid, buttons Submit / Cancel / Get Status. It is also the **return URL**: it reads `SRN`, `STA`, `ITN` from the query string, maps `STA` containing "R" → `REJECTED` and "A" → `ACCEPTED`, and saves the ITN (`SaveShipmentESSubmissionDetails`). |
| `AddAESCommodity.aspx(.cs)` | Add/edit commodity lines (`tbl_aescommodities`); Schedule B picked from `tbl_scheduleBNo` |
| `ConfirmAESSubmissionPopup.aspx(.cs)` | Builds a hidden-field `<form method="post" target="_blank">` and posts it to CBP `createWeblinkFiling`. Commodity lines are added as dynamic hidden fields. |
| `CancelAESPopup.aspx(.cs)` | Same form with `FAC=X` |
| `GetAESStatusPopup.aspx(.cs)` | `GET weblinkFilingInquiry?SRN=&FID=&URL=` (FID hard-coded) |
| Lookups | `tbl_aesexemption`, `tbl_aesexportinformationcode`, `tbl_aeslicensetypecode`, `tbl_scheduleBNo` (+Unit1/Unit2), `tbl_undetails` (UN/LOCODE), `tbl_commerce` (port codes), `tbl_countries`, `tbl_states` |

How WebLink works (CBP docs + the legacy code):
1. The user is logged into the **ACE Portal → exporter account → AESDirect** in the same browser.
2. Our page auto-POSTs the EEI fields to `createWeblinkFiling` in a new tab. AESDirect opens **pre-filled**, the user fixes anything missing and clicks **Submit Filing** inside AESDirect.
3. AESDirect shows the result (time, SRN, ITN, and any "399-VERIFY" / "700-COMPLIANCE ALERT" warnings). Clicking back sends the browser to `wl_success_url` or `wl_nosed_url` (the failure URL). The legacy app read `SRN`, `ITN` and `STA` from that redirect. ⚠️ CBP's public pages don't document those return parameter names, so they must be confirmed in the certification environment. A confirmation email is also sent (`DoNotReply@cbp.dhs.gov`; `DoNotReplyTest@…` in cert).
4. Status/ITN can be re-fetched any time with the **Inquiry** call (`FID`, `SRN`, optional `URL` that must be **https**), which redirects back to `URL` with the result.

Consequences for the design:
- **No server-to-server call, no API key, no stored CBP credential.** CBP auth is the user's own ACE login in their browser. Our server only builds the field set and receives the browser redirect.
- The "response" is **a browser redirect we can't trust blindly**: anyone can hit the return URL with `?ITN=…`. Correlate it with a submission we issued, and treat the ITN as "reported" until the user or an inquiry confirms it.
- A true server-to-server integration needs **ACE ABI / X12 601 via a certified VAN or software provider** (a separate procurement). It's out of scope here and listed as a future option in §9.

### Endpoints (updated 2026-10-26; verify on the first staging run)

| | URL | Source |
|---|---|---|
| Filing, **test/training** (TMS default) | `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling` | CBP "AESDirect WebLink Inquiry API" page, via Sky2C 2026-10-26 |
| Status/inquiry, **test/training** (TMS default) | `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry` | same |
| Filing, production | `https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling` | same |
| Status/inquiry, production | `https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry` | same |
| Sign-in, test | `https://ace-test.cbp.gov/` (ACE Certification portal; login via CBP sandbox IdP `cbplogin--sat.sandbox.my.site.com`, needs a CBP-issued test account). Test AESDirect home: `https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/home` | CBP "Submitting WebLink" v2.0, Sep 2023 |
| Sign-in, production | `https://ace.cbp.gov/` → Accounts → Exporter → "Submit AES Filing" | CSMS #58166135, Oct 2023 |
| ~~Superseded~~ (failed 2026-10-26) | `https://ace.cbp.dhs.gov/aesdc/…` (Akamai 500, ref #3.3f4a3917.1793028167.3a664321); `https://ace.crt.tnc.ace.cbp.dhs.gov/nace/…` (NXDOMAIN); `https://ace.cbp.dhs.gov/nace/…` (old prod) | CSMS #49999216, #49403547, #49955145 (2021) |
| ~~Retired~~ | `…/aesd/ta/cert/aes-direct/…` + `sessionBroker` (2015-era cert PDF) | returns CBP proxy "Server Error" (seen 2026-10-26) |

The legacy app's active filing form posted to `/aesdc/…`, the **test/training** URL per CSMS #49999216, so the old app was filing to training. Its cancel and inquiry pointed at the retired `/aesd/ta/cert/…` paths. Never hard-code these; they belong in env. If CBP moves them again, or Sky2C's ACE account lacks WebLink test access, contact the AES help desk (askaes@census.gov, 1-800-549-0595 opt 1).

### Legacy defects to NOT carry over
- `EMAIL` hard-coded to one person's address; `FID` and the forwarding-agent EIN, name ("Tarun Tandon") and phone hard-coded in the submit popup.
- **Placeholder EPA data sent on every line**: `EPn_2` consent number and `EPn_3` tracking number = `123456789010`, `ACM=NLR` forced.
- `wl_success_url`/`wl_nosed_url` set to google.com/bing.com in the markup (the callback only worked where the code-behind overrode it).
- Cancel popup uses `SCAC = SCACCode` for air (submit correctly uses `IATACode`) and `FAC=X`, which CBP's mapping sheet says WebLink doesn't support (only **A** and **R**).
- Quantities/values as strings with `Convert.ToDouble` (crashes on blanks); state sent as `"CA - California"` and ports as `"code - name, country"` instead of bare codes.
- Status keyed by `FileNumber + ShipmentType`, with `Session["AESShipmentType"]` carried across the redirect.

## 2. WebLink field map (what we must produce)

> **Built 2026-11-18:** every field below is now mapped. The current, field-by-field map (TMS source or the AES details form on the AES page, stored in `ShipmentAes`) is in `docs/aes-field-map.md`; that file wins where this section differs.

From CBP "WebLink Mapping" (May 2023) and the legacy usage. `X` = line 1..99.

| Group | Fields | Source in tms-sky2c |
|---|---|---|
| System | `wl_success_url`, `wl_nosed_url`, `EMAIL` | `${APP_BASE_URL}/api/aes/weblink/return?…`, the logged-in user's email (+ optional ops mailbox) |
| Shipment | `SRN` (≤17), `BN`, `FAC` (A/R), `FO`, `FT`, `ST`, `FTZ`, `POE`, `COD`, `POU`, `EDA` (MM/DD/YYYY), `MOT`, `SCAC`, `VN`, `RCC`, `HAZ`, `RT`, `IBN`, `IBT`, `ORIG_ITN` | `ShipmentAes` + shipment (`fileNumber` → SRN; `bolNumber`/`proNumber` → BN; carrier client → SCAC/IATA + name) |
| USPPI (AD0) | `_1` name, `_2` ID (EIN), `_3` ID type (E/D/T), `_4/_5` addr, `_6` city, `_7` state, `_8` zip, `_9` first, `_11` last, `_12` phone | `Client` (usppiId, defaults to shipper) |
| Ultimate consignee (AD1) | `_3,_5,_6` (sold en route),`_7.._13`,`_14` type (D/G/R/O) | `Client` (defaults to consignee) |
| Forwarding agent (AD3) | `_2` ID type, `_3` name, `_4` EIN, `_5` contact, `_7.._13` | `AppSetting` "aes.filerProfile" (Sky2C), never hard-coded |
| Intermediate consignee (AD4) | `_3,_5,_7.._13` | optional `Client` |
| Commodity lines | `isLineX`, `ITX_1` EIC, `_2` value (whole USD), `_3/_4` UOM1/qty1, `_5/_6` UOM2/qty2, `_7` weight kg, `_8` license type, `_9` license no./ACM, `_10` license value, `_12` description, `_13` Schedule B/HTS (10 digits, no dots), `_15.._19` used vehicle (flag, VIN qualifier, VIN, title, title state), `_20` ECCN, `_21` D/F origin | `AesCommodity` |
| DDTC | `ODTCX_1..7` (+`ODTC1_8`) | `AesCommodity.ddtc*` (only when license type is ITAR) |
| Equipment | `EQX`, `SNX` | `CargoContainer.containerNumber` / `seal1` |
| PGA (phase 2) | `EPX_*`, `AMSX_*`, `FWSX_*`, `ATFX_Z_*`, `NMFSX_Z_*`, `DEAX_Z_*`, `TTBX_Z_*` | Phase 1 sends only the "no license required" flags (`EPX_1=N`, `AMSX_1=N`), **never placeholder numbers** |

## 3. Gaps in the current tms-sky2c model

| Needed | Today | Change |
|---|---|---|
| Party EIN / ID type | ❌ | `Client.einNumber`, `Client.partyIdType` (`E`=EIN, `D`=DUNS, `T`=foreign entity) |
| Carrier SCAC / IATA | ❌ (`carrierPicklist` is free text) | `Client.scacCode`, `Client.iataCode` |
| Two-letter US state / ISO country on parties | free-text `state`/`country` | `Client.stateCode`, `Client.countryCode` (keep the free text for printing) |
| Port codes (Schedule D export port, Schedule K foreign unlading port) | `Location.code` (UN/LOCODE, optional) | `Location.portCode` + `portCodeType` ("D"/"K"), seeded from Census lists |
| Schedule B / HTS catalog | ❌ | new `ScheduleB` collection (code, description, uom1, uom2), import from the Census concordance file |
| AES code lists | ❌ | `LookupValue` categories: `AES_EXEMPTION`, `AES_EXPORT_INFO_CODE`, `AES_LICENSE_TYPE`, `AES_MOT`, `AES_CONSIGNEE_TYPE`, `AES_INBOND_CODE`, `AES_UOM`, `AES_PARTY_ID_TYPE`, `US_STATE`, `COUNTRY` |
| VIN on used vehicles | `CargoItem.vehicle*` but no VIN | `CargoItem.vehicleVin`, `vehicleIdQualifier` |
| Export indicator on a shipment | implicit (layout "…to Port", "US Air Booking", foreign `country`) | `isExport()` helper; AES only enabled for exports (see §8 Q1) |

## 4. Data model (Prisma, MongoDB): additions

```prisma
enum AesStatus {
  DRAFT
  READY
  SUBMITTED
  ACCEPTED
  ACCEPTED_WITH_WARNINGS
  REJECTED
  EXEMPT
}

/// WebLink supports only Add / Replace.
enum AesFilingAction {
  A
  R
}

enum AesSubmissionKind {
  FILING
  INQUIRY
}

enum AesSubmissionOutcome {
  PENDING
  SUCCESS
  FAILURE
  ABANDONED
}

/// One AES header per shipment (1:1, true ownership → real relation, cascade).
model ShipmentAes {
  id          String @id @default(auto()) @map("_id") @db.ObjectId
  shipmentId  String @unique @db.ObjectId
  shipment    DomesticWarehouseShipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  fileNumber  String            // denormalized; = SRN
  status      AesStatus @default(DRAFT)
  itn         String?           // X + 14 digits, validated by regex
  itnConfirmedAt DateTime?      // set by Inquiry/user confirmation, not by the raw redirect
  exemptionCode  String?        // AES_EXEMPTION, e.g. "NOEEI 30.37(a)" → status EXEMPT, no filing
  usppiClientId          String? @db.ObjectId
  ultimateConsigneeClientId String? @db.ObjectId
  ultimateConsigneeType  String?   // D/G/R/O
  soldEnRoute            Boolean @default(false)
  intermediateConsigneeClientId String? @db.ObjectId
  carrierClientId        String? @db.ObjectId
  conveyanceName         String?   // VN
  transportRef           String?   // BN
  modeOfTransport        String?   // MOT code
  originStateCode        String?   // ST
  portOfExportCode       String?   // POE (Schedule D)
  portOfUnladingCode     String?   // POU (Schedule K / D for MOT 10,11,12...)
  countryOfDestination   String?   // COD (ISO-2)
  exportDate             DateTime? // EDA
  partiesRelated         Boolean @default(false)  // RCC
  routedTransaction      Boolean @default(false)  // RT
  hazardous              Boolean @default(false)  // HAZ
  inBondCode             String?   // IBT
  entryNumber            String?   // IBN
  ftzNumber              String?   // FTZ
  filingOption           String?   // FO
  originalItn            String?   // ORIG_ITN
  lastFilingAction       AesFilingAction?
  lastSubmittedAt        DateTime?
  lastResponseAt         DateTime?
  lastResponseRaw        Json?     // query params from the last redirect, verbatim
  commodities  AesCommodity[]
  submissions  AesSubmission[]
  createdBy String? @db.ObjectId
  updatedBy String? @db.ObjectId
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([fileNumber])
  @@index([status])
}

model AesCommodity {
  id            String @id @default(auto()) @map("_id") @db.ObjectId
  aesId         String @db.ObjectId
  aes           ShipmentAes @relation(fields: [aesId], references: [id], onDelete: Cascade)
  lineNo        Int            // 1..99, stable ordering
  cargoItemId   String? @db.ObjectId  // optional link back to the cargo line it came from
  exportInfoCode String        // ITX_1 (e.g. OS)
  scheduleB     String         // ITX_13, 10 digits, stored without dots
  description   String         // ITX_12
  originIndicator String       // ITX_21: D | F
  valueUsdCents Int            // ITX_2 (sent as whole dollars, rounded)
  uom1          String?        // ITX_3
  qty1          Int?           // ITX_4
  uom2          String?        // ITX_5
  qty2          Int?           // ITX_6
  shippingWeightKg Int         // ITX_7
  licenseType  String          // ITX_8 (C33 = NLR …)
  licenseNumber String?        // ITX_9
  licenseValueCents Int?       // ITX_10
  eccn         String?         // ITX_20
  isUsedVehicle      Boolean @default(false)  // ITX_15
  vehicleIdQualifier String?   // ITX_16
  vehicleId          String?   // ITX_17 (VIN / product ID)
  vehicleTitle       String?   // ITX_18
  vehicleTitleState  String?   // ITX_19
  ddtcItarExemption  String?   // ODTCX_1
  ddtcRegistration   String?   // ODTCX_2
  ddtcSme            Boolean?  // ODTCX_3
  ddtcEligibleParty  Boolean?  // ODTCX_4
  ddtcUsmlCategory   String?   // ODTCX_5
  ddtcUom            String?   // ODTCX_6
  ddtcQty            Int?      // ODTCX_7
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([aesId, lineNo])
}

/// SUPERSEDED 2026-11-02 and BUILT 2026-11-05 per docs/aes-audit-log-plan.md §3 (soft refs to shipmentId/fileNumber, no cascade, plus AesAuditEvent).
/// Append-only audit of every hand-off to CBP and every return. Never updated except outcome fields.
model AesSubmission {
  id         String @id @default(auto()) @map("_id") @db.ObjectId
  aesId      String @db.ObjectId
  aes        ShipmentAes @relation(fields: [aesId], references: [id], onDelete: Cascade)
  kind       AesSubmissionKind
  action     AesFilingAction?
  environment String           // "cert" | "production"
  nonce      String @unique    // random; embedded in the return URLs to correlate the redirect
  payloadHash String           // sha256 of the field map sent (payload itself in `payload`)
  payload    Json              // the exact field map posted (no secrets in it)
  outcome    AesSubmissionOutcome @default(PENDING)
  returnedParams Json?
  itnReported String?
  submittedBy String? @db.ObjectId
  submittedAt DateTime @default(now())
  returnedAt  DateTime?
  @@index([aesId, submittedAt])
}

model ScheduleB {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  code String @unique   // 10 digits
  description String
  uom1 String?
  uom2 String?
  isActive Boolean @default(true)
  @@index([description])
}
```
Plus `Client` fields `einNumber`, `partyIdType`, `scacCode`, `iataCode`, `stateCode`, `countryCode`; `Location` fields `portCode`, `portCodeType`; `CargoItem` fields `vehicleVin`, `vehicleIdQualifier`; and back-relation `aes ShipmentAes?` on `DomesticWarehouseShipment`. All fields are optional or defaulted, so `prisma db push` is non-breaking.

## 5. Code layout

```
src/lib/aes/
  config.ts          // env → { enabled, environment, filingUrl, inquiryUrl, filerId, notifyEmail }; throws if prod URL used while AES_ENVIRONMENT=cert
  codes.ts           // MOT, party-ID types, consignee types, FAC, EIC… (labels for UI)
  weblinkFields.ts   // PURE: (aes, shipment, parties, commodities, containers, filerProfile, returnUrls) → Record<string,string>
                     //   bare codes only (no "CA - California"), MM/DD/YYYY, whole dollars, ≤99 lines, field length caps
  validate.ts        // zod + business rules → { errors[], warnings[] } shown before hand-off (see §6)
  aesService.ts      // getOrCreateAes(shipment) with defaults; save; buildHandoff(kind, action) → creates AesSubmission(PENDING) + returns {url, fields}
                     // recordReturn(nonce, outcome, params) ; confirmItn(...) ; markExempt(...)
  itn.ts             // ITN regex /^X\d{14}$/, STA → status mapping (A / R / warnings), sanitize params
src/app/api/shipments/[fileNumber]/aes/route.ts                  // GET (load + defaults) / PUT (save header)
src/app/api/shipments/[fileNumber]/aes/commodities/route.ts      // GET / POST; [id]/route.ts PUT / DELETE; POST ?fromCargo=1 prefill
src/app/api/shipments/[fileNumber]/aes/validate/route.ts         // POST → {errors, warnings}
src/app/api/shipments/[fileNumber]/aes/handoff/route.ts          // POST {kind:"FILING"|"INQUIRY", action?:"A"|"R"} → {url, method, fields} (400 if validation errors)
src/app/api/aes/weblink/return/route.ts                          // GET ?n=<nonce>&o=success|failure + CBP params → record, then 303 to /shipments/<fn>/aes?returned=1
src/app/api/aes/schedule-b/search/route.ts                       // type-ahead (escapeRegex!)
src/app/shipments/[fileNumber]/aes/page.tsx (+ AesForm.tsx, CommodityTable.tsx, CommodityModal.tsx, HandoffForm.tsx)
src/components/ShipmentForm.tsx   // enable the AES button → <Link href=/shipments/<fn>/aes>; disabled with tooltip on unsaved/non-export shipments
src/lib/pdf/templates/*           // print "AES ITN: X…" (or exemption citation) on Straight BOL / Booking Confirmation / Dock Receipt
prisma/seed-aes.ts                // AES lookups + US states + countries; scripts/import-schedule-b.ts (Census file)
```

**Hand-off mechanics (client):** `HandoffForm` receives `{url, fields}`, renders a hidden `<form method="post" action={url} target="_blank">` with one `<input type="hidden">` per field, and submits it in the click handler (same user gesture, so pop-up blockers allow it). The inquiry uses `method="get"` per the legacy code. Verify in cert, since CBP's submission doc mandates POST for filing only.

*(Superseded as built: the return routes are PUBLIC, and the nonce route writes the audit only for a matching nonce; see `docs/aes-audit-log-plan.md` §5.3 and CLAUDE.md.)* **Return route auth:** CBP sends the user's *browser* back with a top-level GET, so the `dwtms_session` cookie (SameSite=Lax) **is** sent. Keep the route behind the normal staff middleware; don't add it to `PUBLIC_PREFIXES`. Two gaps to fix along the way:
- If the session expired, middleware currently keeps only `pathname` in `from` and the query string is lost. Extend `from` to include the search so the redirect can be replayed after login.
- `wl_*` and inquiry `URL` must be **https** and reachable from the user's browser. That works on QA/prod. Locally it only works through a tunnel, or by testing via manual ITN entry.

**Trust model for the return:** the nonce must match a PENDING `AesSubmission` created by this app for that shipment, and `SRN` must equal its `fileNumber`. The ITN must match `/^X\d{14}$/`. With all that, the status becomes `ACCEPTED`/`REJECTED`, `itn` is set and `itnConfirmedAt` stays null until either (a) an Inquiry round-trip returns the same ITN, or (b) a user clicks "Confirm ITN" after checking the CBP confirmation email or screen. Unknown or extra params are stored raw in `returnedParams` for diagnosis. The handler never throws to the user; it always lands back on the AES page with a banner.

## 6. Validation before hand-off (block vs warn)

Block (errors):
- Shipment saved, export destination, `AES_ENABLED=true`.
- Not EXEMPT. If an exemption is set, show the citation instead of filing.
- SRN ≤17 chars.
- USPPI has name, EIN/ID + type, address, US state and contact.
- Ultimate consignee has name, address, country and type.
- MOT, POE, COD and EDA are present; EDA is today or later (or within CBP's allowed window).
- Carrier SCAC (vessel/truck/rail) or IATA (air) is present for the MOT.
- At least 1 and at most 99 commodity lines.
- Every line has a 10-digit Schedule B that exists in `ScheduleB`, EIC, D/F origin, whole-dollar value > 0, weight in kg > 0, license type, and UOM/qty required by that Schedule B.
- A used-vehicle line has a VIN.
- An ITAR line has its DDTC fields.
- `FAC=R` requires an existing ITN.

Warn:
- Total value ≤ $2,500 per Schedule B with no license, which may qualify for an exemption.
- Parties related but routed is unset.
- Hazardous flag set without the hazmat fields that AESDirect will ask for.

## 7. UI flow

On the shipment edit page the AES button enables in edit mode (with a tooltip when disabled). It opens `/shipments/<fn>/aes`:

- **Header strip**: AES status badge, ITN (copy button, "confirmed" tick), environment badge (**orange "CBP CERT / TRAINING" when not production**), last submitted and last response.
- **Sections**:
  - Filing: exemption toggle, filing option, FTZ, in-bond, entry no.
  - Parties: USPPI, ultimate consignee (+type, sold en route), intermediate consignee, defaulted from shipment shipper/consignee via `ClientLookupField`.
  - Transport: MOT, carrier, conveyance, BN, POE/POU/COD/EDA, origin state.
  - Flags: related, routed, hazardous.
- **Commodities**: table + modal. "Prefill from cargo" creates draft lines from `CargoItem`s (description, weight lbs→kg, value, vehicle data). Schedule B type-ahead fills in its UOMs.
- **Equipment**: read-only list of containers and seals from the Cargo page.
- **Actions**: Save · Validate · **File with CBP (Add)** (or **Replace** when an ITN exists) · **Get status (Inquiry)** · Mark exempt · Confirm ITN · View hand-off history (the `AesSubmission` list with payload diff).
- Before a hand-off, the page reminds the user to sign in, in the same browser, to the portal for the configured environment: test → ACE Certification portal `ace-test.cbp.gov` (needs a CBP-issued test account); production → modernized ACE Portal `ace.cbp.gov` → Accounts → Exporter → Submit AES Filing. There is no session-broker step any more.
- **Cancel/void an ITN**: WebLink supports only A/R, so show instructions and a deep link to do it inside AESDirect, then let the user record "Cancelled in AESDirect" (status note + submission row). Confirm in cert whether `FAC=X` is accepted. If it is, add a "Cancel filing" action later.

## 8. Open decisions (need answers before build)

1. **Which shipments get AES?** Options: (a) any shipment whose `country`/destination is non-US, (b) only Zoho layouts "Direct to Port", "Warehouse to Port" and "US Air Booking", (c) a manual "Export shipment" checkbox. Recommend (c), defaulted by (a)/(b).
2. **Who is the filer?** Sky2C as forwarding agent filing for the USPPI (needs a power of attorney/written authorization from each USPPI), or the USPPI self-filing? This drives the AD3 profile and which ACE account is used.
3. **ACE account and filer ID:** confirm Sky2C's ACE exporter account, its AESDirect access and its Filer ID (EIN). The legacy value is in the old code; confirm it's still valid. Also confirm who in ops has ACE logins.
4. **Environments:** QA → CBP **cert/training**; production → CBP **prod** only on the production deployment. This is enforced by `AES_ENVIRONMENT` plus a guard.
5. **Scope of PGA data** (EPA/AMS/FWS/ATF/DEA/NMFS/TTB): phase 1 sends "not required" only. Is any customer shipping regulated goods?
6. Should the ITN be pushed back to Zoho Desk (another custom field via `updateTicket`)? It's cheap to add.

## 9. Delivery plan and estimates (1 developer)

| Phase | Work | Est. |
|---|---|---|
| 0. Prereqs | Answers to §8; ACE cert access for one ops user; confirm prod/cert URLs and return-param names with a manual cert filing using CBP's test file | 1-2 d (mostly waiting) |
| 1. Data | Prisma models + Client/Location/CargoItem fields; `db push`; seed AES lookups, states and countries; Schedule B import script; extend `ClientForm` (EIN, ID type, SCAC, IATA, state/country codes) and `Location` (port code) | 2-3 d |
| 2. Core lib | `src/lib/aes/*` (config, codes, weblinkFields, validate, itn, aesService). Add **vitest** (the repo has no test runner) with golden tests of `weblinkFields` against a legacy-equivalent fixture | 3 d |
| 3. API | Routes in §5, nonce/return handling, middleware `from` fix, audit rows | 2 d |
| 4. UI | AES page, commodity modal, prefill-from-cargo, hand-off form, history, enable the button | 3-4 d |
| 5. Documents | ITN/exemption line on BOL / Booking Confirmation / Dock Receipt templates | 0.5 d |
| 6. Cert testing | End-to-end in CBP training: Add → ITN; Replace; Inquiry; reject path (bad Schedule B); used vehicle; multi-line (>10); session-expired return; spoofed return URL rejected | 2 d |
| 7. Rollout | Env on QA (`AES_ENVIRONMENT=cert`); ops UAT; prod env + flag on; short ops guide (ACE login → AES page) | 1 d |
| | **Total** | **≈ 14-18 dev days** |

Future (not in this plan): ACE **ABI/X12 601** via a certified provider for true server-to-server filing and automatic responses; PGA data sets; bulk AES status refresh.

## 10. New env vars (add to `.env.example`; none are secrets)

```
AES_ENABLED="false"                 # master switch for the button + routes
AES_ENVIRONMENT="cert"              # "cert" | "production" — production refused unless NODE_ENV=production
AES_WEBLINK_FILING_URL=""           # test (default): https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling ; prod: https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling
AES_WEBLINK_INQUIRY_URL=""          # test (default): https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry ; prod: https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry
AES_FILER_ID=""                     # Sky2C filer EIN (FID)
AES_NOTIFY_EMAIL=""                 # optional ops mailbox appended to EMAIL
```
The forwarding-agent profile (name, EIN, contact, address) lives in `AppSetting` key `aes.filerProfile`, editable on a small settings page. It is never hard-coded.

## Sources
- CBP, AESDirect WebLink Submission API — https://www.cbp.gov/trade/automated/aesdirect-weblink-submission-api
- CBP, AESDirect WebLink Inquiry API — https://www.cbp.gov/trade/automated/aesdirect-weblink-inquiry-api
- CBP CSMS #49955145, updated WebLink URLs — https://content.govdelivery.com/accounts/USDHSCBP/bulletins/2fa4149
- CBP, WebLink field mapping (May 2023) — https://www.cbp.gov/sites/default/files/assets/documents/2023-May/WebLinkMapping_5_8_2023_508c.pdf
- CBP, AESDirect WebLink certification/test process — https://cbp.gov/sites/default/files/documents/AESDirectWebLinkTestProcess.pdf
- Legacy code: `ManageShipmentAES`, `AddAESCommodity`, `ConfirmAESSubmissionPopup`, `CancelAESPopup`, `GetAESStatusPopup` (.aspx/.cs), `tbl_shipmentaes`, `tbl_aescommodities`
