/**
 * src/mocks/handlers/gmail-threads.ts
 *
 * MSW request handlers for Gmail Threads API endpoints:
 *   GET  /threads            — list threads
 *   GET  /threads/:id        — get thread
 *   POST /threads/:id/modify — modify thread labels
 *
 * Auth check: requests with "Bearer invalid-token" are rejected with 401.
 */

import { http, HttpResponse } from "msw";
import { INVALID_ACCESS_TOKEN } from "./gmail-labels.js";
import { BINARY_BYTES } from "./gmail-messages.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") && auth !== `Bearer ${INVALID_ACCESS_TOKEN}`;
}

// Re-use the same encoded values as in the messages mock so tests can compare.
const THREAD_TEXT_BODY = Buffer.from("Hello, World!").toString("base64url");
const THREAD_BINARY_BODY = BINARY_BYTES.toString("base64url");

export const MOCK_THREADS = {
  thread_001: {
    id: "thread_001",
    historyId: "12345",
    messages: [
      {
        id: "msg_001",
        threadId: "thread_001",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "First message in thread...",
        // Includes a text/plain body to verify getThread decodes it to UTF-8.
        payload: {
          mimeType: "text/plain",
          body: { data: THREAD_TEXT_BODY, size: 13 },
        },
      },
      {
        id: "msg_003",
        threadId: "thread_001",
        labelIds: ["INBOX"],
        snippet: "Reply in thread...",
        // Includes an image/png body to verify getThread keeps binary as base64,
        // not corrupted UTF-8.
        payload: {
          mimeType: "image/png",
          body: { data: THREAD_BINARY_BODY, size: BINARY_BYTES.length },
        },
      },
    ],
  },
  thread_002: {
    id: "thread_002",
    historyId: "12346",
    messages: [
      {
        id: "msg_002",
        threadId: "thread_002",
        labelIds: ["INBOX", "Label_1"],
        snippet: "Work message...",
      },
    ],
  },
};

export const gmailThreadsHandlers = [
  /** GET /threads — list threads. */
  http.get(`${BASE}/threads`, ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    return HttpResponse.json({
      threads: [
        { id: "thread_001", snippet: "First message in thread...", historyId: "12345" },
        { id: "thread_002", snippet: "Work message...", historyId: "12346" },
      ],
      resultSizeEstimate: 2,
    });
  }),

  /** GET /threads/:threadId — get thread. */
  http.get(`${BASE}/threads/:threadId`, ({ params, request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const { threadId } = params as { threadId: string };
    const thread = MOCK_THREADS[threadId as keyof typeof MOCK_THREADS];
    if (!thread) {
      return HttpResponse.json(
        { error: { code: 404, message: "Thread not found." } },
        { status: 404 }
      );
    }
    return HttpResponse.json(thread);
  }),

  /** POST /threads/:threadId/modify — modify thread labels. */
  http.post(`${BASE}/threads/:threadId/modify`, async ({ params, request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    const { threadId } = params as { threadId: string };
    const body = (await request.json()) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };

    const thread = MOCK_THREADS[threadId as keyof typeof MOCK_THREADS];
    if (!thread) {
      return HttpResponse.json(
        { error: { code: 404, message: "Thread not found." } },
        { status: 404 }
      );
    }

    // Simulate applying label changes to each message in the thread.
    const updatedMessages = thread.messages?.map((msg) => {
      const labels = new Set(msg.labelIds ?? []);
      for (const id of body.addLabelIds ?? []) labels.add(id);
      for (const id of body.removeLabelIds ?? []) labels.delete(id);
      return { ...msg, labelIds: [...labels] };
    });

    return HttpResponse.json({ ...thread, messages: updatedMessages });
  }),
];
