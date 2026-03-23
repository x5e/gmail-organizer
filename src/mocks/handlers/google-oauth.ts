/**
 * src/mocks/handlers/google-oauth.ts
 *
 * MSW request handlers for Google OAuth and JWKS endpoints:
 *   POST https://oauth2.googleapis.com/token
 *   GET  https://www.googleapis.com/oauth2/v3/certs
 *
 * Produces properly signed JWTs so that production code can verify
 * id_token signatures against the mock JWKS.
 */

import { generateKeyPairSync } from "node:crypto";
import { SignJWT, exportJWK } from "jose";
import { http, HttpResponse } from "msw";

/** A valid mock access token returned on successful auth. */
export const MOCK_ACCESS_TOKEN = "mock-access-token-xyz";
export const MOCK_REFRESH_TOKEN = "mock-refresh-token-abc";
export const MOCK_NEW_ACCESS_TOKEN = "mock-refreshed-access-token-xyz";
export const MOCK_USER_EMAIL = "testuser@example.com";

const TEST_KEY_ID = "test-key-1";
const TEST_AUDIENCE = "test-client-id";
const GOOGLE_ISSUER = "https://accounts.google.com";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

let cachedJwks: { keys: object[] } | null = null;

async function getJwks(): Promise<{ keys: object[] }> {
  if (!cachedJwks) {
    const jwk = await exportJWK(publicKey);
    jwk.kid = TEST_KEY_ID;
    jwk.use = "sig";
    jwk.alg = "RS256";
    cachedJwks = { keys: [jwk] };
  }
  return cachedJwks;
}

/**
 * Builds a signed mock id_token. Exported so tests can create tokens with
 * custom claims (e.g. email_verified: false, wrong audience, expired).
 */
export async function buildMockIdToken(
  email: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    email,
    email_verified: true,
    sub: "1234567890",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: TEST_KEY_ID })
    .setIssuer(overrides.iss as string ?? GOOGLE_ISSUER)
    .setAudience(overrides.aud as string ?? TEST_AUDIENCE)
    .setIssuedAt(overrides.iat as number ?? now)
    .setExpirationTime(overrides.exp as number ?? now + 3600);

  return builder.sign(privateKey);
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
        id_token: await buildMockIdToken(MOCK_USER_EMAIL),
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

  /** GET https://www.googleapis.com/oauth2/v3/certs — JWKS for id_token verification. */
  http.get("https://www.googleapis.com/oauth2/v3/certs", async () => {
    return HttpResponse.json(await getJwks());
  }),
];
