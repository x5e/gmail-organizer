/**
 * src/mocks/handlers/gmail-history.ts
 *
 * MSW request handler for the Gmail History endpoint:
 *   GET /history
 *
 * Auth check: requests with "Bearer invalid-token" are rejected with 401.
 */

import { http, HttpResponse } from "msw";
import { INVALID_ACCESS_TOKEN } from "./gmail-labels.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") && auth !== `Bearer ${INVALID_ACCESS_TOKEN}`;
}

export const MOCK_HISTORY = {
  history: [
    {
      id: "12346",
      messages: [{ id: "msg_002", threadId: "thread_002" }],
      labelsAdded: [
        {
          message: { id: "msg_002", threadId: "thread_002", labelIds: ["INBOX", "Label_1"] },
          labelIds: ["Label_1"],
        },
      ],
    },
  ],
  nextPageToken: undefined,
  historyId: "12350",
};

export const gmailHistoryHandlers = [
  /** GET /history — returns mailbox change history. */
  http.get(`${BASE}/history`, ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }

    const url = new URL(request.url);
    const startHistoryId = url.searchParams.get("startHistoryId");

    // Simulate "history ID too old" error (Google returns 404 in this case).
    if (startHistoryId === "old_history_id") {
      return HttpResponse.json(
        { error: { code: 404, message: "Start history ID is too old." } },
        { status: 404 }
      );
    }

    return HttpResponse.json(MOCK_HISTORY);
  }),
];
