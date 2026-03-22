/**
 * src/mocks/handlers/gmail-profile.ts
 *
 * MSW request handler for the Gmail Profile endpoint:
 *   GET /profile
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

export const MOCK_PROFILE = {
  emailAddress: "testuser@example.com",
  messagesTotal: 165,
  threadsTotal: 62,
  historyId: "99999",
};

export const gmailProfileHandlers = [
  /** GET /profile — returns account profile. */
  http.get(`${BASE}/profile`, ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json(
        { error: { code: 401, message: "Unauthorized" } },
        { status: 401 }
      );
    }
    return HttpResponse.json(MOCK_PROFILE);
  }),
];
