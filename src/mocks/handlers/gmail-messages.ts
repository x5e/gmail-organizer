/**
 * src/mocks/handlers/gmail-messages.ts
 *
 * MSW request handlers for Gmail Messages API endpoints:
 *   GET  /messages               — search messages
 *   GET  /messages/:id           — get single message
 *   GET  /messages/:id/attachments/:attachmentId — get attachment
 *   POST /messages/:id/modify    — modify message labels
 *   POST /messages/batchModify   — batch modify message labels
 *
 * Auth check: requests with "Bearer invalid-token" are rejected with 401.
 */

import { http, HttpResponse } from "msw";
import { INVALID_ACCESS_TOKEN } from "./gmail-labels.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Returns true if the Authorization header represents a valid test token. */
function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") && auth !== `Bearer ${INVALID_ACCESS_TOKEN}`;
}

/** Sample message bodies (base64url-encoded). */
// "Hello, World!" in base64url
const ENCODED_BODY = Buffer.from("Hello, World!").toString("base64url");

export const MOCK_MESSAGES = {
  msg_001: {
    id: "msg_001",
    threadId: "thread_001",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hello from the test...",
    historyId: "12345",
    internalDate: "1700000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "recipient@example.com" },
        { name: "Subject", value: "Test Subject" },
        { name: "Date", value: "Tue, 14 Nov 2023 12:00:00 +0000" },
      ],
      body: { data: ENCODED_BODY, size: 13 },
    },
    sizeEstimate: 512,
  },
  msg_002: {
    id: "msg_002",
    threadId: "thread_002",
    labelIds: ["INBOX", "Label_1"],
    snippet: "Another test message...",
    historyId: "12346",
    internalDate: "1700001000000",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Plain text body").toString("base64url"), size: 15 },
        },
        {
          mimeType: "application/pdf",
          filename: "document.pdf",
          body: { attachmentId: "attach_001", size: 50000 },
        },
      ],
    },
    sizeEstimate: 50512,
  },
};

export const MOCK_ATTACHMENT = {
  size: 13,
  data: Buffer.from("PDF content here").toString("base64url"),
};

export const gmailMessagesHandlers = [
  /** GET /messages — search messages. */
  http.get(`${BASE}/messages`, ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";

    // Return empty results for queries that won't match anything in our mock.
    if (q === "no-results-query") {
      return HttpResponse.json({ messages: [], resultSizeEstimate: 0 });
    }

    return HttpResponse.json({
      messages: [
        { id: "msg_001", threadId: "thread_001" },
        { id: "msg_002", threadId: "thread_002" },
      ],
      resultSizeEstimate: 2,
    });
  }),

  /** GET /messages/:messageId — get single message. */
  http.get(`${BASE}/messages/:messageId`, ({ params, request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const { messageId } = params as { messageId: string };
    const message = MOCK_MESSAGES[messageId as keyof typeof MOCK_MESSAGES];
    if (!message) {
      return HttpResponse.json(
        { error: { code: 404, message: "Message not found." } },
        { status: 404 }
      );
    }
    return HttpResponse.json(message);
  }),

  /** GET /messages/:messageId/attachments/:attachmentId — get attachment. */
  http.get(`${BASE}/messages/:messageId/attachments/:attachmentId`, ({ params, request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const { attachmentId } = params as { messageId: string; attachmentId: string };
    if (attachmentId === "not_found") {
      return HttpResponse.json(
        { error: { code: 404, message: "Attachment not found." } },
        { status: 404 }
      );
    }
    return HttpResponse.json(MOCK_ATTACHMENT);
  }),

  /** POST /messages/:messageId/modify — modify message labels. */
  http.post(`${BASE}/messages/:messageId/modify`, async ({ params, request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const { messageId } = params as { messageId: string };
    const body = (await request.json()) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };

    const message = MOCK_MESSAGES[messageId as keyof typeof MOCK_MESSAGES];
    if (!message) {
      return HttpResponse.json(
        { error: { code: 404, message: "Message not found." } },
        { status: 404 }
      );
    }

    // Simulate label modification.
    const currentLabels = new Set(message.labelIds ?? []);
    for (const id of body.addLabelIds ?? []) currentLabels.add(id);
    for (const id of body.removeLabelIds ?? []) currentLabels.delete(id);

    return HttpResponse.json({ ...message, labelIds: [...currentLabels] });
  }),

  /** POST /messages/batchModify — batch modify message labels. */
  http.post(`${BASE}/messages/batchModify`, async ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    // Gmail returns 204 No Content on success.
    return new HttpResponse(null, { status: 204 });
  }),
];
