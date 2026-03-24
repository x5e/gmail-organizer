/**
 * src/tools/index.ts
 *
 * Registers all 11 Gmail MCP tools on the given MCP server instance.
 *
 * Tools provided:
 *   Read-only (readOnlyHint: true):
 *     1. list_labels          — List all labels in the account
 *     2. search_messages      — Search messages by Gmail query
 *     3. list_threads         — List conversation threads
 *     4. get_message          — Retrieve a full message
 *     5. get_attachment       — Retrieve a message attachment
 *     6. get_thread           — Retrieve a full thread
 *     7. get_history          — Get mailbox change history
 *     8. get_profile          — Get account profile and current historyId
 *
 *   Write (destructiveHint: false):
 *     9.  modify_message_labels       — Add/remove labels on a single message
 *    10.  modify_thread_labels        — Add/remove labels on all messages in a thread
 *    11.  batch_modify_message_labels — Add/remove labels on up to 1,000 messages
 *
 * Each tool handler:
 *   1. Extracts the user ID from the MCP request context (bearer token).
 *   2. Calls withGmailRetry, which:
 *        a. Retrieves a valid access token (refreshing proactively if near expiry).
 *        b. Calls the Gmail API.
 *        c. On a 401 response, force-refreshes the token and retries once.
 *           This handles tokens invalidated before their local expiry timestamp
 *           (revocation, clock skew, unexpected auth state changes).
 *   3. Returns a structured result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type postgres from "postgres";
import { getValidAccessToken, forceRefreshAccessToken } from "../oauth/tokens.js";
import * as gmail from "../gmail/client.js";
import { assertNoBlockedLabels, assertLabelsExist } from "./validation.js";
import { GmailApiError, base64UrlToBase64 } from "../gmail/client.js";

/** Maximum message IDs allowed in a single batchModify request (Google limit). */
const BATCH_MODIFY_MAX = 1000;

/**
 * Recursively searches a MIME part tree for the part whose body.attachmentId
 * matches the given ID and returns its mimeType.
 */
function findPartMimeType(
  part: gmail.GmailMessagePart | undefined,
  attachmentId: string
): string | undefined {
  if (!part) return undefined;
  if (part.body?.attachmentId === attachmentId) return part.mimeType;
  for (const subPart of part.parts ?? []) {
    const found = findPartMimeType(subPart, attachmentId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Wraps a tool handler to provide consistent error handling and logging.
 * Converts GmailApiError and generic errors into MCP-compatible error responses.
 */
function handleToolError(err: unknown): never {
  if (err instanceof GmailApiError) {
    if (err.status === 401 || err.status === 403) {
      throw new Error(
        `Gmail authorization error: ${err.message}. ` +
          "The user may need to re-authenticate."
      );
    }
    if (err.status === 404) {
      throw new Error(`Gmail resource not found: ${err.message}`);
    }
    if (err.status === 429) {
      throw new Error(
        `Gmail API rate limit exceeded. Please wait a moment and try again.`
      );
    }
    throw new Error(`Gmail API error: ${err.message}`);
  }
  throw err;
}

/**
 * Calls fn with a valid access token. If Gmail returns 401, force-refreshes
 * the token and retries fn exactly once before failing.
 *
 * This handles the case where a cached token becomes invalid before its local
 * expiry timestamp (e.g. revocation, clock skew, unexpected auth state change).
 */
async function withGmailRetry<T>(
  db: postgres.Sql,
  userId: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const token = await getValidAccessToken(db, userId);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 401) {
      let freshToken: string;
      try {
        freshToken = await forceRefreshAccessToken(db, userId);
      } catch (refreshErr) {
        // Classify the refresh failure. Only known auth-rejection responses
        // from Google's token endpoint (400 invalid_grant, 401 unauthorized)
        // mean the refresh token is revoked/expired — surface a clean reauth
        // prompt. Everything else (network errors, 5xx, other 4xx like 429
        // rate-limiting) is operational and should propagate as-is.
        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        const isAuthRejection =
          /\(400\)/.test(msg) && /invalid_grant/i.test(msg) ||
          /\(401\)/.test(msg);
        if (isAuthRejection) {
          // Use a fixed, user-safe message — never include the raw OAuth
          // response body which may contain internal token-endpoint details.
          throw new GmailApiError(
            401,
            "Refresh token is no longer valid"
          );
        }
        // Network error, 5xx, rate-limit, or anything else — not an auth issue.
        throw refreshErr;
      }
      return fn(freshToken);
    }
    throw err;
  }
}

/**
 * Registers all Gmail MCP tools on the provided MCP server.
 *
 * @param server - The MCP server instance to register tools on.
 * @param db - The postgres.js connection pool for token lookups.
 * @param getUserId - Function to extract the user ID from the current request context.
 */
export function registerTools(
  server: McpServer,
  db: postgres.Sql,
  getUserId: () => string
): void {
  // ─── 1. list_labels ──────────────────────────────────────────────────────────

  server.tool(
    "list_labels",
    "List all labels in the user's Gmail account, including system labels (INBOX, SENT, etc.) and user-created labels. Returns label IDs needed for other operations.",
    {},
    { readOnlyHint: true },
    async () => {
      const userId = getUserId();
      try {
        const labels = await withGmailRetry(db, userId, (token) =>
          gmail.listLabels(token)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(labels, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 2. search_messages ──────────────────────────────────────────────────────

  server.tool(
    "search_messages",
    "Search for messages matching a Gmail query string (e.g. 'from:user@example.com is:unread'). Returns message IDs and thread IDs. Use nextPageToken for pagination.",
    {
      q: z.string().describe("Gmail search query string"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(20)
        .describe("Maximum number of results to return (1-500, default 20)"),
      pageToken: z
        .string()
        .optional()
        .describe("Page token from a previous response for pagination"),
    },
    { readOnlyHint: true },
    async ({ q, maxResults, pageToken }) => {
      const userId = getUserId();
      try {
        const result = await withGmailRetry(db, userId, (token) =>
          gmail.searchMessages(token, { q, maxResults, pageToken })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 3. list_threads ─────────────────────────────────────────────────────────

  server.tool(
    "list_threads",
    "List conversation threads in the user's mailbox. Operates at the conversation level. Optionally filter by Gmail query or label ID. Returns thread IDs and snippets.",
    {
      q: z
        .string()
        .optional()
        .describe("Gmail search query to filter threads"),
      labelIds: z
        .array(z.string())
        .optional()
        .describe("Filter to threads carrying these label IDs"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(20)
        .describe("Maximum number of threads to return (1-500, default 20)"),
      pageToken: z
        .string()
        .optional()
        .describe("Page token from a previous response for pagination"),
    },
    { readOnlyHint: true },
    async ({ q, labelIds, maxResults, pageToken }) => {
      const userId = getUserId();
      try {
        const result = await withGmailRetry(db, userId, (token) =>
          gmail.listThreads(token, { q, labelIds, maxResults, pageToken })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 4. get_message ──────────────────────────────────────────────────────────

  server.tool(
    "get_message",
    "Retrieve the full content of a single message by ID, including headers, decoded body, attachment metadata, and current label state.",
    {
      messageId: z.string().describe("The Gmail message ID"),
      format: z
        .enum(["full", "metadata", "minimal"])
        .default("full")
        .describe(
          "full = complete message with decoded body (default); " +
            "metadata = headers and label IDs only; " +
            "minimal = message IDs, label IDs, and size estimate only"
        ),
    },
    { readOnlyHint: true },
    async ({ messageId, format }) => {
      const userId = getUserId();
      try {
        const message = await withGmailRetry(db, userId, (token) =>
          gmail.getMessage(token, messageId, format)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(message, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 5. get_attachment ───────────────────────────────────────────────────────

  server.tool(
    "get_attachment",
    "Retrieve the content of a specific message attachment by its attachment ID. Attachment IDs are found in get_message responses when body data is omitted (large attachments).",
    {
      messageId: z.string().describe("The Gmail message ID containing the attachment"),
      attachmentId: z
        .string()
        .describe("The attachment ID from the message's MIME payload"),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024)
        .default(1024 * 1024)
        .describe(
          "Maximum bytes of attachment data to return (default 1MB). " +
            "Large attachments are truncated with a note."
        ),
    },
    { readOnlyHint: true },
    async ({ messageId, attachmentId, maxBytes }) => {
      const userId = getUserId();
      try {
        const { attachment, message } = await withGmailRetry(
          db,
          userId,
          async (token) => {
            const [attachment, message] = await Promise.all([
              gmail.getAttachment(token, messageId, attachmentId),
              gmail.getMessage(token, messageId, "full"),
            ]);
            return { attachment, message };
          }
        );

        // Resolve the MIME type from the message's part tree.
        const mimeType =
          findPartMimeType(message.payload, attachmentId) ??
          "application/octet-stream";

        // Convert base64url → padded standard base64.
        const base64 = base64UrlToBase64(attachment.data ?? "");
        const decoded = Buffer.from(base64, "base64");

        let truncated = false;
        let content: string;

        if (mimeType.startsWith("text/")) {
          // Safe to interpret as UTF-8 text.
          if (decoded.length > maxBytes) {
            content = decoded.subarray(0, maxBytes).toString("utf8");
            truncated = true;
          } else {
            content = decoded.toString("utf8");
          }
        } else {
          // Binary content: return as standard base64 to avoid UTF-8 corruption.
          if (decoded.length > maxBytes) {
            content = decoded.subarray(0, maxBytes).toString("base64");
            truncated = true;
          } else {
            content = base64;
          }
        }

        const result = {
          mimeType,
          size: attachment.size,
          truncated,
          returnedBytes: Math.min(decoded.length, maxBytes),
          data: content,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 6. get_thread ───────────────────────────────────────────────────────────

  server.tool(
    "get_thread",
    "Retrieve the full content of a thread (all messages in a conversation), including current label state of each message.",
    {
      threadId: z.string().describe("The Gmail thread ID"),
    },
    { readOnlyHint: true },
    async ({ threadId }) => {
      const userId = getUserId();
      try {
        const thread = await withGmailRetry(db, userId, (token) =>
          gmail.getThread(token, threadId)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(thread, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 7. get_history ──────────────────────────────────────────────────────────

  server.tool(
    "get_history",
    "Return a list of mailbox changes (messages added, labels changed) since a given history ID. Use this for efficient incremental sync rather than re-scanning the entire inbox.",
    {
      startHistoryId: z
        .string()
        .describe(
          "The history ID to start from (from a previous message, thread, or get_profile response)"
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of history records to return (default 100)"),
      pageToken: z
        .string()
        .optional()
        .describe("Page token from a previous response for pagination"),
    },
    { readOnlyHint: true },
    async ({ startHistoryId, maxResults, pageToken }) => {
      const userId = getUserId();
      try {
        const history = await withGmailRetry(db, userId, (token) =>
          gmail.getHistory(token, { startHistoryId, maxResults, pageToken })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(history, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 8. get_profile ──────────────────────────────────────────────────────────

  server.tool(
    "get_profile",
    "Returns basic account information: email address, total message count, and current history ID. The historyId is a useful starting point for change tracking with get_history.",
    {},
    { readOnlyHint: true },
    async () => {
      const userId = getUserId();
      try {
        const profile = await withGmailRetry(db, userId, (token) =>
          gmail.getProfile(token)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(profile, null, 2),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 9. modify_message_labels ────────────────────────────────────────────────

  server.tool(
    "modify_message_labels",
    "Add and/or remove labels on a single message. TRASH and SPAM operations are blocked. Use list_labels to get valid label IDs.",
    {
      messageId: z.string().describe("The Gmail message ID to modify"),
      addLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to add to the message"),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to remove from the message"),
    },
    { destructiveHint: false },
    async ({ messageId, addLabelIds, removeLabelIds }) => {
      assertNoBlockedLabels(addLabelIds, removeLabelIds);

      const userId = getUserId();
      const allLabelIds = [...(addLabelIds ?? []), ...(removeLabelIds ?? [])];

      try {
        const message = await withGmailRetry(db, userId, async (token) => {
          await assertLabelsExist(token, allLabelIds);
          return gmail.modifyMessageLabels(token, messageId, {
            addLabelIds,
            removeLabelIds,
          });
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Labels updated on message ${messageId}`,
                  updatedMessage: message,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 10. modify_thread_labels ────────────────────────────────────────────────

  server.tool(
    "modify_thread_labels",
    "Add and/or remove labels on all messages in a thread simultaneously. This is the primary tool for conversation-level organization. TRASH and SPAM operations are blocked.",
    {
      threadId: z.string().describe("The Gmail thread ID to modify"),
      addLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to add to all messages in the thread"),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to remove from all messages in the thread"),
    },
    { destructiveHint: false },
    async ({ threadId, addLabelIds, removeLabelIds }) => {
      assertNoBlockedLabels(addLabelIds, removeLabelIds);

      const userId = getUserId();
      const allLabelIds = [...(addLabelIds ?? []), ...(removeLabelIds ?? [])];

      try {
        const thread = await withGmailRetry(db, userId, async (token) => {
          await assertLabelsExist(token, allLabelIds);
          return gmail.modifyThreadLabels(token, threadId, {
            addLabelIds,
            removeLabelIds,
          });
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Labels updated on thread ${threadId}`,
                  updatedThread: thread,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );

  // ─── 11. batch_modify_message_labels ─────────────────────────────────────────

  server.tool(
    "batch_modify_message_labels",
    `Add and/or remove labels on up to ${BATCH_MODIFY_MAX} messages in a single operation. Ideal for bulk organization tasks. TRASH and SPAM operations are blocked.`,
    {
      ids: z
        .array(z.string())
        .min(1)
        .max(BATCH_MODIFY_MAX)
        .describe(`Message IDs to modify (1 to ${BATCH_MODIFY_MAX})`),
      addLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to add to all specified messages"),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Label IDs to remove from all specified messages"),
    },
    { destructiveHint: false },
    async ({ ids, addLabelIds, removeLabelIds }) => {
      assertNoBlockedLabels(addLabelIds, removeLabelIds);

      const userId = getUserId();
      const allLabelIds = [...(addLabelIds ?? []), ...(removeLabelIds ?? [])];

      try {
        await withGmailRetry(db, userId, async (token) => {
          await assertLabelsExist(token, allLabelIds);
          return gmail.batchModifyMessageLabels(token, {
            ids,
            addLabelIds,
            removeLabelIds,
          });
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Labels updated on ${ids.length} message(s)`,
                  affectedMessageCount: ids.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        handleToolError(err);
      }
    }
  );
}
