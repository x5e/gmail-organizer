/**
 * src/mocks/handlers/google-oauth.ts
 *
 * MSW request handler for Google OAuth token endpoints:
 *   POST https://oauth2.googleapis.com/token
 *
 * Handles both authorization_code exchange and refresh_token grant types.
 */

import { http, HttpResponse } from "msw";

/** A valid mock access token returned on successful auth. */
export const MOCK_ACCESS_TOKEN = "mock-access-token-xyz";
export const MOCK_REFRESH_TOKEN = "mock-refresh-token-abc";
export const MOCK_NEW_ACCESS_TOKEN = "mock-refreshed-access-token-xyz";

export const googleOAuthHandlers = [
  /** POST https://oauth2.googleapis.com/token — token exchange / refresh. */
  http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
    const body = await request.text();
    const params = new URLSearchParams(body);
    const grantType = params.get("grant_type");

    if (grantType === "authorization_code") {
      const code = params.get("code");
      if (code === "invalid_code") {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Code was already redeemed." },
          { status: 400 }
        );
      }
      return HttpResponse.json({
        access_token: MOCK_ACCESS_TOKEN,
        expires_in: 3600,
        refresh_token: MOCK_REFRESH_TOKEN,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      if (refreshToken === "invalid_refresh_token") {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Token has been expired or revoked." },
          { status: 400 }
        );
      }
      return HttpResponse.json({
        access_token: MOCK_NEW_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }

    return HttpResponse.json(
      { error: "unsupported_grant_type" },
      { status: 400 }
    );
  }),
];
