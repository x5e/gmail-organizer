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
export const MOCK_USER_EMAIL = "testuser@example.com";

/**
 * Builds a minimal unsigned JWT id_token with the given email claim.
 * Only the payload section is meaningful; header and signature are placeholders.
 */
function buildMockIdToken(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    sub: "1234567890",
    email,
    email_verified: true,
    aud: "mock-client-id",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const signature = Buffer.from("mock-signature").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

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
        id_token: buildMockIdToken(MOCK_USER_EMAIL),
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify openid email",
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
        scope: "https://www.googleapis.com/auth/gmail.modify openid email",
      });
    }

    return HttpResponse.json(
      { error: "unsupported_grant_type" },
      { status: 400 }
    );
  }),
];
