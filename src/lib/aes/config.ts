import { toFilerId } from "@/lib/aes/codes";

/**
 * AES (CBP ACE AESDirect WebLink) configuration.
 *
 * WebLink is a browser hand-off, not a server API: the user's browser POSTs the EEI
 * fields to `createWeblinkFiling` while they're signed in to the ACE Portal, AESDirect
 * opens pre-filled, the user submits it there, and CBP redirects the browser back to
 * our wl_success_url / wl_nosed_url. Status is re-fetched the same way through
 * `weblinkFilingInquiry` (FID + SRN + https return URL). Nothing here is a secret — CBP
 * auth is the user's own ACE login in their browser.
 *
 * For now only the CBP certification/training ("staging") environment is used. Pointing
 * at production requires AES_ENVIRONMENT="production" AND explicit AES_WEBLINK_* URLs AND
 * a production NODE_ENV, so a dev box can never file a real export declaration by accident.
 * (QA runs with NODE_ENV=production, so on QA the explicit env vars are the only guard.)
 */

/**
 * CBP WebLink TEST/TRAINING ("staging") environment — current URLs from CBP's "AESDirect WebLink
 * Inquiry API" page (provided by Sky2C 2026-10-26), on the modernized "trade" host:
 *   Filing  test: https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling
 *   Status  test: https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry
 *   Filing  prod: https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling
 *   Status  prod: https://trade.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry
 * Production URLs are never a default — they must be configured explicitly (see getAesConfig).
 *
 * Superseded test URLs (all failed 2026-10-26 — don't reuse):
 *  - https://ace.cbp.dhs.gov/aesdc/aes/aesdirect-ui/secured/… (CSMS #49999216; legacy Sky2CWeb):
 *    CBP Akamai "Internal Server Error" (Reference #3.3f4a3917.1793028167.3a664321).
 *  - https://ace.crt.tnc.ace.cbp.dhs.gov/nace/aes/aesdirect-ui/secured/… (CSMS #49403547):
 *    host does not resolve (DNS NXDOMAIN).
 *  - https://ace.cbp.dhs.gov/aesd/ta/cert/aes-direct/… + "sessionBroker": retired ("Server Error").
 * Keep these constants identical to the AES_WEBLINK_* values in .env.example.
 */
export const CBP_CERT_FILING_URL = "https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/createWeblinkFiling";
export const CBP_CERT_INQUIRY_URL = "https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/weblinkFilingInquiry";
/**
 * ACE Certification (test) portal — where the user signs in before a trade-test hand-off, per CBP's
 * "Submitting WebLink" v2.0 (Sep 2023). After sign-in, test AESDirect is at
 * https://trade-test.cbp.dhs.gov/ace/aes/aesdirect-ui/secured/home (orange "TRAINING ENVIRONMENT" banner).
 */
export const ACE_TEST_PORTAL_URL = "https://ace-test.cbp.gov/";
/**
 * Modernized ACE Portal — since Oct 21, 2023 AESDirect launches only from here
 * (CSMS #58166135): Accounts → Exporter → "Submit AES Filing".
 */
export const ACE_PORTAL_URL = "https://ace.cbp.gov/";
/** CBP AES help desk, for WebLink access/URL questions. */
export const AES_HELP_DESK = { email: "askaes@census.gov", phone: "1-800-549-0595 (option 1)" } as const;

// Short TMS guide to AES filing (PDF in public/aes), opened by "How it works".
export const AES_USER_GUIDE = { url: "/aes/aesdirect-user-guide.pdf" } as const;

// Sky2C as registered in ACE (Exporter account, ACE ID 1004374260, active). Used when the
// AES_FILER_ID / AES_FORWARDER_CLIENT_ID settings are empty. Address: 1500 Atlantic St, Union City.
export const SKY2C_FILER_ID = "943355318";
export const SKY2C_AGENT = {
  clientId: "",
  name: "SKY 2 C FREIGHT SYSTEMS INC",
  street: "1500 ATLANTIC ST",
  addressLine1: null,
  addressLine2: null,
  city: "UNION CITY",
  state: "CA",
  zipCode: "94587",
  country: "US",
  telephone: "5107433300",
  contact: null,
  contactLastName: null,
} as const;

export type AesEnvironment = "cert" | "production";

export interface AesConfig {
  enabled: boolean;
  environment: AesEnvironment;
  filingUrl: string;
  /** Where the user must be signed in for WebLink to work: the ACE Portal on the same host family as filingUrl. */
  portalUrl: string;
  inquiryUrl: string;
  /** Sky2C's filer ID (EIN) — FID on inquiries and the forwarding agent's party ID (AD3_4). Defaults to SKY2C_FILER_ID. */
  filerId: string;
  /** Client.clientId of a Client record with Sky2C's details for AD3_*. "" = use SKY2C_AGENT. */
  forwarderClientId: string;
  /** Optional extra address(es) for CBP's response email, comma-separated, appended to the user's own. */
  notifyEmail: string;
  /** Problem that makes filing unavailable, shown in the UI instead of the hand-off button. */
  configError: string | null;
  /** Non-blocking configuration problems, shown on the AES page. */
  configWarnings: string[];
}

/**
 * True for CBP test/training URLs across the hosts/paths CBP has used: "trade-test" (current),
 * "/aesdc/", ".crt." and "/cert/" (older). Production is "trade.cbp.dhs.gov" (formerly "/nace/") —
 * anything not recognized as test/training is treated as production, so the guards fail safe.
 */
export function isCertUrl(url: string): boolean {
  return url.includes("/aesdc/") || url.includes(".crt.") || url.includes("/cert/") || url.includes("trade-test");
}

/**
 * Where the user signs in before a hand-off. WebLink only pre-fills AESDirect for a browser signed in
 * on the same environment: the test "trade-test" host → the ACE Certification portal (ace-test.cbp.gov,
 * per CBP's WebLink guide v2.0; it redirects to CBP's "sat" sandbox login); a ".crt." host → its own
 * site; everything else (production) → the modernized ACE Portal.
 */
export function portalUrlFor(filingUrl: string): string {
  try {
    const host = new URL(filingUrl).host;
    if (host.startsWith("trade-test.")) return ACE_TEST_PORTAL_URL;
    if (host.includes(".crt.")) return `https://${host}/`;
  } catch {
    // fall through
  }
  return ACE_PORTAL_URL;
}

export function getAesConfig(): AesConfig {
  const enabled = (process.env.AES_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const environment: AesEnvironment = process.env.AES_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "cert";
  const explicitFilingUrl = process.env.AES_WEBLINK_FILING_URL?.trim() ?? "";
  const explicitInquiryUrl = process.env.AES_WEBLINK_INQUIRY_URL?.trim() ?? "";

  let filingUrl = CBP_CERT_FILING_URL;
  let inquiryUrl = CBP_CERT_INQUIRY_URL;
  let configError: string | null = null;
  const configWarnings: string[] = [];

  if (environment === "production") {
    if (process.env.NODE_ENV !== "production") {
      configError = "AES_ENVIRONMENT=production is refused outside a production build.";
    } else if (!explicitFilingUrl || !explicitInquiryUrl) {
      configError = "AES_ENVIRONMENT=production needs AES_WEBLINK_FILING_URL and AES_WEBLINK_INQUIRY_URL set explicitly.";
    } else if (isCertUrl(explicitFilingUrl) || isCertUrl(explicitInquiryUrl)) {
      configError = "AES_ENVIRONMENT=production but an AES_WEBLINK_* URL points at the CBP cert environment.";
    } else {
      filingUrl = explicitFilingUrl;
      inquiryUrl = explicitInquiryUrl;
    }
  } else {
    // Allow overriding the cert URLs (CBP has moved them before), but never to a non-cert path.
    if (explicitFilingUrl) {
      if (isCertUrl(explicitFilingUrl)) filingUrl = explicitFilingUrl;
      else configError = "AES_WEBLINK_FILING_URL looks like a production URL while AES_ENVIRONMENT is cert.";
    }
    if (explicitInquiryUrl) {
      if (isCertUrl(explicitInquiryUrl)) inquiryUrl = explicitInquiryUrl;
      else configError = "AES_WEBLINK_INQUIRY_URL looks like a production URL while AES_ENVIRONMENT is cert.";
    }
  }

  if (!filingUrl.startsWith("https://") || !inquiryUrl.startsWith("https://")) {
    configError = "AES_WEBLINK_* URLs must be https.";
  }

  // FID is at most 11 alphanumeric characters (CBP WebLink Inquiry API); an EIN is 9 digits.
  // Empty setting = Sky2C's own EIN.
  let filerId = toFilerId(process.env.AES_FILER_ID) || SKY2C_FILER_ID;
  if (!/^[A-Z0-9]{9,11}$/.test(filerId)) {
    configWarnings.push(`AES_FILER_ID "${process.env.AES_FILER_ID}" isn't a valid filer ID (9–11 letters/digits, e.g. an EIN) — Sky2C's EIN is used instead.`);
    filerId = SKY2C_FILER_ID;
  }

  // Empty setting = the built-in Sky2C details (SKY2C_AGENT).
  const forwarderClientId = (process.env.AES_FORWARDER_CLIENT_ID ?? "").trim();

  return {
    enabled,
    environment,
    filingUrl,
    inquiryUrl,
    portalUrl: portalUrlFor(filingUrl),
    filerId,
    forwarderClientId,
    notifyEmail: (process.env.AES_NOTIFY_EMAIL ?? "").trim(),
    configError,
    configWarnings,
  };
}
