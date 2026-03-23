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

// PNG magic bytes — a real binary sequence that is NOT valid UTF-8.
// Byte 0x89 is not valid UTF-8 and will become the replacement character if
// naively decoded with toString("utf8"), making corruption detectable in tests.
export const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  // msg_003: a message with an inline binary part (embedded PNG image).
  // Used to verify that decodeMessageParts does NOT corrupt binary body.data.
  msg_003: {
    id: "msg_003",
    threadId: "thread_001",
    labelIds: ["INBOX"],
    snippet: "Image message...",
    historyId: "12347",
    internalDate: "1700002000000",
    payload: {
      mimeType: "image/png",
      body: { data: BINARY_BYTES.toString("base64url"), size: BINARY_BYTES.length },
    },
    sizeEstimate: 256,
  },
  // msg_004: a message with a text/plain attachment (not inline body.data).
  // Used to verify that get_attachment decodes text attachments to UTF-8.
  msg_004: {
    id: "msg_004",
    threadId: "thread_003",
    labelIds: ["INBOX"],
    snippet: "Text attachment message...",
    historyId: "12348",
    internalDate: "1700003000000",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Cover note").toString("base64url"), size: 10 },
        },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { attachmentId: "attach_text_001", size: 17 },
        },
      ],
    },
    sizeEstimate: 512,
  },
};

// Binary attachment — real PNG magic bytes encoded as base64url.
// Corruption test: toString("utf8") on these bytes produces a replacement char.
export const MOCK_ATTACHMENT = {
  size: BINARY_BYTES.length,
  data: BINARY_BYTES.toString("base64url"),
};

// Text attachment — plain ASCII content.
export const MOCK_TEXT_ATTACHMENT = {
  size: 17,
  data: Buffer.from("Hello attachment!").toString("base64url"),
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
    if (attachmentId === "attach_text_001") {
      return HttpResponse.json(MOCK_TEXT_ATTACHMENT);
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
