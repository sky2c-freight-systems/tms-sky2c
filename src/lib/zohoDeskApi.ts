/**
 * Outbound Zoho Desk API client — the reverse direction of src/app/api/webhooks/zoho/*
 * (which is Zoho calling INTO this app). This module is our app calling INTO Zoho, used
 * to push the generated shipment fileNumber back onto the originating ticket's
 * "Reference Number" field once a shipment is created from that ticket.
 *
 * Auth: a single fixed Self Client app (Client ID/Secret/refresh token in env), not a
 * per-user OAuth session like the QuickBooks integration — there's exactly one Zoho
 * Desk org this app talks to, so a simple in-memory access-token cache (refreshed via
 * the static refresh token on expiry) is appropriate here; this is NOT the same "don't
 * use in-memory OAuth state" concern that applied to QBO, since there's no per-connection
 * user session to leak across requests.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function refreshAccessToken(): Promise<CachedToken> {
  const accountsDomain = process.env.ZOHO_DESK_ACCOUNTS_DOMAIN ?? "https://accounts.zoho.in";
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requireEnv("ZOHO_DESK_CLIENT_ID"),
    client_secret: requireEnv("ZOHO_DESK_CLIENT_SECRET"),
    refresh_token: requireEnv("ZOHO_DESK_REFRESH_TOKEN"),
  });

  const res = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho Desk token refresh failed: ${JSON.stringify(body)}`);
  }

  const expiresInMs = (body.expires_in ?? 3600) * 1000;
  const token: CachedToken = {
    accessToken: body.access_token,
    // Refresh 2 minutes early rather than waiting for an actual 401.
    expiresAt: Date.now() + expiresInMs - 2 * 60 * 1000,
  };
  cachedToken = token;
  return token;
}

// After a failed refresh, further attempts fail fast for this long instead of hitting
// Zoho again. Zoho locks out a refresh token that's retried in a tight loop ("You have
// made too many requests continuously"), which otherwise happens when credentials are
// wrong — every webhook made several API calls, each one re-trying the refresh.
const REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
let lastRefreshFailure: { at: number; message: string } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  if (lastRefreshFailure && Date.now() - lastRefreshFailure.at < REFRESH_FAILURE_COOLDOWN_MS) {
    throw new Error(`${lastRefreshFailure.message} (not retrying during cooldown)`);
  }
  try {
    const token = await refreshAccessToken();
    lastRefreshFailure = null;
    return token.accessToken;
  } catch (err) {
    lastRefreshFailure = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
    throw err;
  }
}

/**
 * Shared request helper for every Zoho Desk API call this app makes (ticket CRUD, threads,
 * mail reply addresses, send-reply). Ticket CRUD lives under desk.zoho.<tld>, NOT
 * www.zohoapis.<tld> (which 404s for this resource). Sends orgId both as a header and a
 * query param since different Desk API endpoints have been observed expecting either.
 * Retries once on a 401 in case the cached token expired between the last check and the
 * actual call.
 */
async function zohoDeskRequest<T = unknown>(
  method: string,
  path: string,
  opts: {
    searchParams?: Record<string, string>;
    body?: unknown;
    treatNotFoundAsEmpty?: boolean;
    /** Extra statuses (beyond 404 via treatNotFoundAsEmpty) that mean "nothing here" for this endpoint. */
    emptyOnStatuses?: number[];
    headers?: Record<string, string>;
  } = {},
  isRetry = false
): Promise<T | null> {
  const apiDomain = process.env.ZOHO_DESK_API_DOMAIN ?? "https://desk.zoho.in";
  const orgId = requireEnv("ZOHO_DESK_ORG_ID");
  const accessToken = await getAccessToken();

  const url = new URL(`${apiDomain}${path}`);
  url.searchParams.set("orgId", orgId);
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      orgId,
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && !isRetry) {
    cachedToken = null; // force a fresh refresh
    return zohoDeskRequest<T>(method, path, opts, true);
  }

  // Confirmed live against this org: a ticket with zero attachments returns 404
  // URL_NOT_FOUND from this endpoint rather than 200 with an empty `data` array. Callers
  // that know "not found" really means "empty" for their endpoint opt into this instead of
  // getting a thrown error for what's actually the normal "no attachments" case.
  if (res.status === 404 && opts.treatNotFoundAsEmpty) {
    return null;
  }
  if (opts.emptyOnStatuses?.includes(res.status)) {
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoho Desk API ${method} ${path} failed (${res.status}): ${body}`);
  }

  if (res.status === 204) return null;
  return res.json().catch(() => null) as Promise<T | null>;
}

/**
 * PATCH https://desk.zoho.in/api/v1/tickets/{ticketId} with an arbitrary field payload
 * (e.g. `{ cf: { cf_pickup_country: "2065XXXXX" } }` — see ZOHO_DESK_REFERENCE_NUMBER_FIELD
 * for why that's the real API name of the "Reference Number" field despite the mismatched
 * name; confirmed directly against the live ticket API, not guessed).
 *
 * Gated on ZOHO_DESK_PUSH_ENABLED. This is the single choke point for every write this
 * app makes into the live Zoho Desk org (fileNumber push-back and shipment-status
 * push-back both land here), so the guard lives here rather than at each call site — a
 * dev/QA database seeded with real ticket ids would otherwise mutate real tickets as a
 * side effect of ordinary local testing.
 */
export async function updateTicket(ticketId: string, payload: Record<string, unknown>): Promise<void> {
  if (process.env.ZOHO_DESK_PUSH_ENABLED !== "true") {
    console.info(
      `[zoho] push disabled (ZOHO_DESK_PUSH_ENABLED != "true"); ` +
        `skipping ticket ${ticketId} update: ${JSON.stringify(payload)}`
    );
    return;
  }

  await zohoDeskRequest("PATCH", `/api/v1/tickets/${encodeURIComponent(ticketId)}`, { body: payload });
}

/**
 * AfterShip tracking updates (src/lib/aftershipZohoSync.ts) have their own gate,
 * AFTERSHIP_ZOHO_UPDATE_ENABLED, so they can be turned on without the fileNumber/status
 * push-back that ZOHO_DESK_PUSH_ENABLED controls. Callers check it and dry-run when off.
 */
export function isAftershipZohoUpdateEnabled(): boolean {
  return process.env.AFTERSHIP_ZOHO_UPDATE_ENABLED === "true";
}

/** PATCHes ticket custom fields for an AfterShip update. No-op unless that gate is on. */
export async function updateTicketFieldsFromAftership(ticketId: string, cf: Record<string, string>): Promise<void> {
  if (!isAftershipZohoUpdateEnabled()) return;
  await zohoDeskRequest("PATCH", `/api/v1/tickets/${encodeURIComponent(ticketId)}`, { body: { cf } });
}

/** Adds a private (agent-only) plain-text comment to a ticket. No-op unless the AfterShip gate is on. */
export async function addPrivateTicketComment(ticketId: string, content: string): Promise<void> {
  if (!isAftershipZohoUpdateEnabled()) return;
  await zohoDeskRequest("POST", `/api/v1/tickets/${encodeURIComponent(ticketId)}/comments`, {
    body: { isPublic: false, contentType: "plainText", content },
  });
}

/**
 * Pushes the generated shipment fileNumber onto the originating ticket's custom
 * "Reference Number" field. Best-effort by design — callers should catch and log
 * rather than let this block shipment creation, same philosophy as the rest of the
 * Zoho integration (the shipment/ZohoSync record is the source of truth; this is a
 * courtesy push-back to Zoho, not something shipment creation should ever fail on).
 *
 * ZOHO_DESK_REFERENCE_NUMBER_FIELD has no fallback default on purpose: this API name is
 * highly org-specific (confirmed for this org to be `cf_pickup_country` — a field
 * originally created under that name and later relabeled "Reference Number" in the UI,
 * its label and API name having diverged) and silently guessing wrong here would write
 * the file number into the wrong field instead of failing loudly.
 */
export async function pushFileNumberToZohoTicket(ticketId: string, fileNumber: string): Promise<void> {
  // The ZOHO_DESK_PUSH_ENABLED gate is enforced centrally in updateTicket; checked here too
  // so a deployment with push turned off doesn't also need the field name configured.
  if (process.env.ZOHO_DESK_PUSH_ENABLED !== "true") return;
  const fieldApiName = requireEnv("ZOHO_DESK_REFERENCE_NUMBER_FIELD");
  await updateTicket(ticketId, { cf: { [fieldApiName]: fileNumber } });
}

/**
 * Zoho only includes parent/child ticket data (`relationshipType`, `parentTicket`) in
 * ticket responses when this header is sent, and webhook payloads never carry it at all —
 * so the parent link has to be read back through the API. See Zoho's parent-child
 * ticketing automation example (help.zoho.com community, "Automation#26").
 */
const PARENT_CHILD_HEADERS = { featureFlags: "lookUp" };

/**
 * Full ticket, including `relationshipType` / `parentTicket`, in roughly the same shape as
 * a webhook payload — so it can go straight into createShipmentForTicket for a child
 * ticket whose own department isn't covered by the webhook. The contact isn't included
 * (that needs a contacts scope): a child shipment takes its account from the parent.
 */
export async function getTicketWithRelationship(ticketId: string): Promise<Record<string, unknown> | null> {
  return zohoDeskRequest<Record<string, unknown>>("GET", `/api/v1/tickets/${encodeURIComponent(ticketId)}`, {
    headers: PARENT_CHILD_HEADERS,
  });
}

/**
 * Ids of every child ticket of a parent ticket, via Zoho's parent-child related list
 * (max 50 per page). Confirmed live against Sky2C's org: `{ data: [{ id, ticketNumber,
 * relationshipType: "Child", ... }] }`, paged with from=0.
 */
export async function listChildTicketIds(parentTicketId: string): Promise<string[]> {
  const PAGE = 50;
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const res = await zohoDeskRequest<{ data?: Record<string, unknown>[] }>("GET", "/api/v1/relatedListData", {
      searchParams: {
        module: "tickets",
        relatedListName: "parent_child_ticketing",
        entityId: parentTicketId,
        from: String(from),
        limit: String(PAGE),
      },
      headers: PARENT_CHILD_HEADERS,
      treatNotFoundAsEmpty: true,
      // Confirmed live: a ticket that isn't a parent gets 422 "entityId is invalid"
      // rather than an empty list.
      emptyOnStatuses: [422],
    });
    const items = res?.data ?? [];
    for (const item of items) {
      const id = item.id;
      if (id) ids.add(String(id));
    }
    if (items.length < PAGE) break;
  }
  ids.delete(parentTicketId);
  return [...ids];
}

interface ZohoTicketSummary {
  departmentId: string;
  contactEmail: string | null;
}

export interface ZohoTicketAttachment {
  id: string;
  name: string;
  size?: number;
}

/**
 * Filename prefixes (case-insensitive) marking a Zoho Desk ticket attachment as safe to
 * surface on the unauthenticated customer tracking page, the internal invoice view, and
 * (via attachSignedBolToQboInvoice in qbo.ts) the QBO auto-attach — everything else on
 * the ticket (internal notes, carrier paperwork, etc.) stays internal-only on the
 * unfiltered internal attachments page. Extend this list if ops adopts other
 * customer-facing naming conventions, but don't default to "show everything" — the
 * tracking page is reachable by anyone who has the tracking code, not just the customer.
 */
const CUSTOMER_VISIBLE_ATTACHMENT_PREFIXES = ["PICKUP_ZOHO", "BOL_SIGNED_PICKUP_ZOHO", "BOL_SIGNED_DELIVERY_ZOHO"];

export function isCustomerVisibleAttachment(name: string): boolean {
  const upper = name.toUpperCase();
  return CUSTOMER_VISIBLE_ATTACHMENT_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Lists attachments on a ticket, used to find the customer-signed BOL (named
 * BOL_SIGNED... by ops convention) for pushing into the QBO invoice's
 * attachments — see attachSignedBolToQboInvoice in qbo.ts.
 *
 * `data[].id`/`name`/`size` confirmed live against this org's real attachments payload
 * (also includes `href`, `previewurl`, `creatorId`, `isPublic`, `createdTime`, unused here).
 * `treatNotFoundAsEmpty` is required, not optional: this org's API returns 404 for a ticket
 * with zero attachments instead of 200 with an empty array — confirmed live, not a guess.
 */
export async function getTicketAttachments(ticketId: string): Promise<ZohoTicketAttachment[]> {
  const data = await zohoDeskRequest<{ data: Array<{ id: string; name: string; size?: number }> }>(
    "GET",
    `/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments`,
    { treatNotFoundAsEmpty: true }
  );
  return data?.data ?? [];
}

export interface DownloadedAttachment {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

/**
 * Downloads a single ticket attachment's raw bytes. Bypasses zohoDeskRequest
 * (which always parses the response as JSON) since this endpoint returns the
 * file content directly.
 *
 * The `/content` suffix is required — confirmed live against this org (the same path
 * without it returns 405 METHOD_NOT_ALLOWED); it matches the `href` the attachments-list
 * endpoint itself returns for each attachment.
 */
export async function downloadTicketAttachment(
  ticketId: string,
  attachmentId: string
): Promise<DownloadedAttachment> {
  const apiDomain = process.env.ZOHO_DESK_API_DOMAIN ?? "https://desk.zoho.in";
  const orgId = requireEnv("ZOHO_DESK_ORG_ID");
  const accessToken = await getAccessToken();

  const url = new URL(
    `${apiDomain}/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/content`
  );
  url.searchParams.set("orgId", orgId);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, orgId },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zoho Desk attachment download failed (${res.status}) for ${attachmentId}: ${body}`);
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const dispositionName = res.headers
    .get("content-disposition")
    ?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const buffer = Buffer.from(await res.arrayBuffer());

  return {
    filename: dispositionName ? decodeURIComponent(dispositionName) : attachmentId,
    contentType,
    buffer,
  };
}

async function getTicketSummary(ticketId: string): Promise<ZohoTicketSummary> {
  const data = await zohoDeskRequest<{ departmentId: string; email: string | null }>(
    "GET",
    `/api/v1/tickets/${encodeURIComponent(ticketId)}`
  );
  if (!data) throw new Error(`Zoho Desk ticket ${ticketId} not found`);
  return { departmentId: data.departmentId, contactEmail: data.email ?? null };
}

/**
 * Picks the department's default "from" address, falling back to the first active one.
 *
 * Prefers ZOHO_DESK_REPLY_FROM_ADDRESS when set: this org's Self Client OAuth grant lacks
 * the settings-read scope that /api/v1/mailReplyAddress requires (confirmed via a live
 * 403 SCOPE_MISMATCH, not a guess), and every ticket this app processes routes through the
 * single "Dispatch Ops" department, so a configured override avoids re-granting/regenerating
 * that OAuth token just for this one lookup. Falls back to the live API call in case the
 * scope is ever added and the override is removed.
 */
async function getDepartmentFromAddress(departmentId: string): Promise<string> {
  const override = process.env.ZOHO_DESK_REPLY_FROM_ADDRESS;
  if (override) return override;

  const data = await zohoDeskRequest<{ data: Array<{ address: string; isDepartmentDefault: boolean }> }>(
    "GET",
    "/api/v1/mailReplyAddress",
    { searchParams: { departmentId, isActive: "true" } }
  );
  const addresses = data?.data ?? [];
  const chosen = addresses.find((a) => a.isDepartmentDefault) ?? addresses[0];
  if (!chosen?.address) {
    throw new Error(`No active reply mail address configured for department ${departmentId}`);
  }
  return chosen.address;
}

/** Pulls bare, lowercased, deduped email addresses out of a Zoho thread's raw `"Name"<addr>` header-style string. */
function extractEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const matches = raw.match(/[^\s<>",;]+@[^\s<>",;]+/g) ?? [];
  return Array.from(new Set(matches.map((e) => e.toLowerCase())));
}

interface ThreadParticipants {
  to: string[];
  cc: string[];
}

/** Reply-all recipients are derived from the most recent thread's sender + to/cc, same as clicking "Reply All" in the Desk UI. */
async function getLatestThreadParticipants(ticketId: string): Promise<ThreadParticipants> {
  const data = await zohoDeskRequest<{
    data: Array<{ fromEmailAddress: string | null; to: string | null; cc: string | null }>;
  }>("GET", `/api/v1/tickets/${encodeURIComponent(ticketId)}/threads`, {
    searchParams: { sortBy: "-sendDateTime", limit: "1" },
  });
  const latest = data?.data?.[0];
  if (!latest) return { to: [], cc: [] };
  return {
    to: Array.from(new Set([...extractEmails(latest.fromEmailAddress), ...extractEmails(latest.to)])),
    cc: extractEmails(latest.cc),
  };
}

/**
 * Posts a public "reply all" into a Zoho Desk ticket's conversation — the same effect as
 * an agent clicking "Reply All" in the Desk UI, but triggered from our code when a
 * file/order number is generated. The "from" address is whatever this ticket's department
 * has configured as its reply mail address (never a hardcoded address, since different
 * departments send as different mailboxes); recipients are the latest thread's sender +
 * to/cc (minus our own from address), falling back to the ticket's primary contact email
 * if the thread yields no usable recipient.
 *
 * Gated on ZOHO_DESK_REPLY_ENABLED — same "disabled by default" philosophy as
 * ZOHO_DESK_PUSH_ENABLED, since this posts a real, customer-visible reply into a live
 * ticket rather than a silent field update.
 */
export async function replyAllFileGeneratedNotice(ticketId: string, content: string): Promise<void> {
  if (process.env.ZOHO_DESK_REPLY_ENABLED !== "true") {
    console.info(
      `[zoho] reply disabled (ZOHO_DESK_REPLY_ENABLED != "true"); skipping reply-all for ticket ${ticketId}`
    );
    return;
  }

  const { departmentId, contactEmail } = await getTicketSummary(ticketId);
  const fromEmailAddress = await getDepartmentFromAddress(departmentId);
  const fromLower = fromEmailAddress.toLowerCase();

  const { to, cc } = await getLatestThreadParticipants(ticketId);
  let toRecipients = to.filter((e) => e !== fromLower);
  const ccRecipients = cc.filter((e) => e !== fromLower && !toRecipients.includes(e));

  if (toRecipients.length === 0 && contactEmail) {
    toRecipients = [contactEmail.toLowerCase()];
  }
  if (toRecipients.length === 0) {
    throw new Error(`No recipient could be determined for ticket ${ticketId} reply-all`);
  }

  await zohoDeskRequest("POST", `/api/v1/tickets/${encodeURIComponent(ticketId)}/sendReply`, {
    searchParams: { sendImmediately: "true", isPrivate: "false" },
    body: {
      channel: "EMAIL",
      fromEmailAddress,
      to: toRecipients.join(","),
      cc: ccRecipients.length ? ccRecipients.join(",") : undefined,
      content,
      contentType: "plainText",
    },
  });
}
