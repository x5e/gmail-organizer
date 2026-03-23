/**
 * src/gmail/client.ts
 *
 * Thin wrapper around the Gmail REST API.
 *
 * All methods accept a valid access token as their first argument and make
 * authenticated requests to https://gmail.googleapis.com/gmail/v1/users/me/.
 *
 * Error handling: Gmail API errors are thrown as `GmailApiError` instances
 * with the HTTP status code and Google's error message surfaced. Callers
 * (tool handlers) catch these and return human-readable MCP error responses.
 *
 * No caching or retry logic lives here — token refresh is handled upstream
 * in src/oauth/tokens.ts before any GmailClient call.
 */

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Structured error for Gmail API failures. */
export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(`Gmail API error ${status}: ${message}`);
    this.name = "GmailApiError";
  }
}

/** A single Gmail label as returned by the API. */
export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

/** A message reference returned by search/list operations. */
export interface MessageRef {
  id: string;
  threadId: string;
}

/** A thread reference returned by list operations. */
export interface ThreadRef {
  id: string;
  snippet?: string;
  historyId?: string;
}

/** Full message object from get_message. */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  raw?: string;
}

/** A single MIME message part (recursive for multipart messages). */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string; // base64url encoded
  };
  parts?: GmailMessagePart[];
}

/** Full thread object from get_thread. */
export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

/** Attachment body from get_attachment. */
export interface GmailAttachment {
  size: number;
  data: string; // base64url encoded
}

/** User profile from get_profile. */
export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/** History record from get_history. */
export interface GmailHistory {
  history?: Array<{
    id: string;
    messages?: MessageRef[];
    messagesAdded?: Array<{ message: GmailMessage }>;
    labelsAdded?: Array<{ message: GmailMessage; labelIds: string[] }>;
    labelsRemoved?: Array<{ message: GmailMessage; labelIds: string[] }>;
  }>;
  nextPageToken?: string;
  historyId: string;
}

/**
 * Makes an authenticated GET request to the Gmail API.
 */
async function gmailGet<T>(
  accessToken: string,
  path: string,
  params?: Record<string, string | number | string[]>
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      response.statusText;
    throw new GmailApiError(response.status, message, body);
  }

  return response.json() as Promise<T>;
}

/**
 * Makes an authenticated POST request to the Gmail API.
 */
async function gmailPost<T>(
  accessToken: string,
  path: string,
  body: unknown
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      (errorBody as { error?: { message?: string } })?.error?.message ??
      response.statusText;
    throw new GmailApiError(response.status, message, errorBody);
  }

  // batchModify returns 204 No Content on success
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ─── Label operations ────────────────────────────────────────────────────────

/**
 * Lists all labels in the user's Gmail account.
 */
export async function listLabels(
  accessToken: string
): Promise<GmailLabel[]> {
  const data = await gmailGet<{ labels?: GmailLabel[] }>(
    accessToken,
    "/labels"
  );
  return data.labels ?? [];
}

// ─── Message operations ──────────────────────────────────────────────────────

/**
 * Searches for messages matching a Gmail query string.
 */
export async function searchMessages(
  accessToken: string,
  {
    q,
    maxResults,
    pageToken,
  }: { q: string; maxResults?: number; pageToken?: string }
): Promise<{ messages: MessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }> {
  const params: Record<string, string | number> = { q, maxResults: maxResults ?? 20 };
  if (pageToken) params["pageToken"] = pageToken;

  const data = await gmailGet<{
    messages?: MessageRef[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(accessToken, "/messages", params);

  return {
    messages: data.messages ?? [],
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  };
}

/**
 * Retrieves the full content of a single message by ID.
 * Decodes base64url-encoded body parts into plain strings.
 */
export async function getMessage(
  accessToken: string,
  messageId: string,
  format: "full" | "metadata" | "minimal" = "full"
): Promise<GmailMessage> {
  const message = await gmailGet<GmailMessage>(
    accessToken,
    `/messages/${messageId}`,
    { format }
  );

  if (format === "full") {
    decodeMessageParts(message.payload);
  }

  return message;
}

/**
 * Recursively decodes base64url-encoded body data in message parts.
 * Mutates the payload tree in place.
 *
 * - text/* parts: decoded to a UTF-8 string (human-readable).
 * - All other MIME types: converted from base64url to standard base64 and
 *   stored as-is (no byte→string interpretation). This avoids corrupting
 *   binary content such as PDFs, images, and Office documents.
 */
function decodeMessageParts(part?: GmailMessagePart): void {
  if (!part) return;

  if (part.body?.data) {
    if (part.mimeType?.startsWith("text/")) {
      part.body.data = decodeBase64Url(part.body.data);
    } else {
      part.body.data = base64UrlToBase64(part.body.data);
    }
  }

  if (part.parts) {
    for (const subPart of part.parts) {
      decodeMessageParts(subPart);
    }
  }
}

/**
 * Decodes a base64url string to UTF-8.
 * Only use this for known text/* content; binary data must use base64UrlToBase64.
 */
export function decodeBase64Url(encoded: string): string {
  // base64url uses - and _ instead of + and /
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Converts a base64url string to standard base64 without decoding to bytes.
 * Safe for binary content because no UTF-8 interpretation occurs.
 *
 * Handles both character substitution (- → +, _ → /) and = padding so the
 * result is always a valid RFC 4648 base64 string (length divisible by 4).
 * Gmail base64url values are frequently unpadded; omitting this step causes
 * failures with strict decoders.
 */
export function base64UrlToBase64(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  // Add = padding so the length is a multiple of 4.
  return base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, "=");
}

/**
 * Retrieves the content of a specific message attachment.
 */
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<GmailAttachment> {
  const data = await gmailGet<GmailAttachment>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`
  );
  return data;
}

/**
 * Modifies the labels on a single message.
 */
export async function modifyMessageLabels(
  accessToken: string,
  messageId: string,
  { addLabelIds, removeLabelIds }: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<GmailMessage> {
  return gmailPost<GmailMessage>(accessToken, `/messages/${messageId}/modify`, {
    addLabelIds: addLabelIds ?? [],
    removeLabelIds: removeLabelIds ?? [],
  });
}

/**
 * Batch-modifies labels on up to 1,000 messages in a single operation.
 */
export async function batchModifyMessageLabels(
  accessToken: string,
  {
    ids,
    addLabelIds,
    removeLabelIds,
  }: { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<void> {
  await gmailPost<void>(accessToken, "/messages/batchModify", {
    ids,
    addLabelIds: addLabelIds ?? [],
    removeLabelIds: removeLabelIds ?? [],
  });
}

// ─── Thread operations ───────────────────────────────────────────────────────

/**
 * Lists threads in the user's mailbox.
 */
export async function listThreads(
  accessToken: string,
  {
    q,
    labelIds,
    maxResults,
    pageToken,
  }: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }
): Promise<{ threads: ThreadRef[]; nextPageToken?: string; resultSizeEstimate?: number }> {
  const params: Record<string, string | number | string[]> = {
    maxResults: maxResults ?? 20,
  };
  if (q) params["q"] = q;
  if (labelIds?.length) params["labelIds"] = labelIds;
  if (pageToken) params["pageToken"] = pageToken;

  const data = await gmailGet<{
    threads?: ThreadRef[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(accessToken, "/threads", params);

  return {
    threads: data.threads ?? [],
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  };
}

/**
 * Retrieves the full content of a thread including all messages.
 * Applies the same base64url body decoding to each message as getMessage does,
 * so text parts are readable UTF-8 and binary parts are safe base64 strings.
 */
export async function getThread(
  accessToken: string,
  threadId: string
): Promise<GmailThread> {
  const thread = await gmailGet<GmailThread>(accessToken, `/threads/${threadId}`);
  for (const message of thread.messages ?? []) {
    decodeMessageParts(message.payload);
  }
  return thread;
}

/**
 * Modifies the labels on all messages in a thread.
 */
export async function modifyThreadLabels(
  accessToken: string,
  threadId: string,
  { addLabelIds, removeLabelIds }: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<GmailThread> {
  return gmailPost<GmailThread>(accessToken, `/threads/${threadId}/modify`, {
    addLabelIds: addLabelIds ?? [],
    removeLabelIds: removeLabelIds ?? [],
  });
}

// ─── History ─────────────────────────────────────────────────────────────────

/**
 * Returns a list of changes to the mailbox since the given history ID.
 */
export async function getHistory(
  accessToken: string,
  {
    startHistoryId,
    maxResults,
    pageToken,
  }: { startHistoryId: string; maxResults?: number; pageToken?: string }
): Promise<GmailHistory> {
  const params: Record<string, string | number | string[]> = {
    startHistoryId,
    historyTypes: ["labelAdded", "labelRemoved", "messageAdded"],
    maxResults: maxResults ?? 100,
  };
  if (pageToken) params["pageToken"] = pageToken;

  return gmailGet<GmailHistory>(accessToken, "/history", params);
}

// ─── Profile ─────────────────────────────────────────────────────────────────

/**
 * Returns basic account information including the current history ID.
 */
export async function getProfile(accessToken: string): Promise<GmailProfile> {
  return gmailGet<GmailProfile>(accessToken, "/profile");
}
