/**
 * src/mocks/handlers/gmail-labels.ts
 *
 * MSW request handlers for Gmail Labels API endpoints:
 *   GET /gmail/v1/users/me/labels
 *
 * These handlers are activated during tests to intercept outbound HTTP requests
 * to the Gmail API, allowing the full request-building code path (including
 * auth headers and query parameters) to be exercised without a real API call.
 */

import { http, HttpResponse } from "msw";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Sample labels returned by the mock. */
export const MOCK_LABELS = [
  { id: "INBOX", name: "INBOX", type: "system", messagesTotal: 42, messagesUnread: 5 },
  { id: "SENT", name: "SENT", type: "system", messagesTotal: 120, messagesUnread: 0 },
  { id: "DRAFT", name: "DRAFT", type: "system", messagesTotal: 3, messagesUnread: 0 },
  { id: "STARRED", name: "STARRED", type: "system", messagesTotal: 7, messagesUnread: 0 },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system", messagesTotal: 15, messagesUnread: 2 },
  { id: "UNREAD", name: "UNREAD", type: "system", messagesTotal: 5, messagesUnread: 5 },
  { id: "Label_1", name: "Work", type: "user", messagesTotal: 88, messagesUnread: 3 },
  { id: "Label_2", name: "Personal", type: "user", messagesTotal: 23, messagesUnread: 1 },
];

/** Sentinel access token value that triggers a 401 response in all mock handlers. */
export const INVALID_ACCESS_TOKEN = "invalid-token";

export const gmailLabelsHandlers = [
  /** GET /labels — returns list of labels. */
  http.get(`${BASE}/labels`, ({ request }) => {
    const auth = request.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ") || auth === `Bearer ${INVALID_ACCESS_TOKEN}`) {
      return HttpResponse.json(
        { error: { code: 401, message: "Request had invalid authentication credentials." } },
        { status: 401 }
      );
    }
    return HttpResponse.json({ labels: MOCK_LABELS });
  }),
];
