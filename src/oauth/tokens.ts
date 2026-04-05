/**
 * src/oauth/tokens.ts
 *
 * OAuth token management: storing, retrieving, and refreshing Google OAuth tokens.
 *
 * This module is the single point of contact for anything that needs a valid
 * Google access token. It handles:
 *   - Encrypting refresh tokens before writing to the database
 *   - Decrypting refresh tokens when reading back from the database
 *   - Proactive access-token refresh (5-minute buffer before expiry)
 *   - Caching the access token to avoid redundant calls to Google's token endpoint
 *
 * Usage in tool handlers:
 *   const accessToken = await getValidAccessToken(userId);
 *   // use accessToken for Gmail API calls
 */

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { encrypt, decrypt } from "../crypto.js";
import {
  findOrCreateUserByEmail,
  insertBearerToken,
  resolveToken,
  upsertOAuthTokens,
  updateAccessToken,
  getOAuthTokens,
  type OAuthTokenRow,
} from "../db/users.js";
import type postgres from "postgres";

/** Google OAuth token endpoint. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google's JWKS endpoint for id_token signature verification. */
const GOOGLE_JWKS_URI = new URL("https://www.googleapis.com/oauth2/v3/certs");

/** Expected issuer in Google id_tokens. */
const GOOGLE_ISSUER = "https://accounts.google.com";

/** Cached JWKS fetcher — lazily retrieves and caches Google's public keys. */
const googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URI);

/** How many seconds before expiry to proactively refresh. */
const REFRESH_BUFFER_SECONDS = 5 * 60; // 5 minutes

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope?: string;
}

export interface ExchangeResult {
  userId: string;
  bearerToken: string;
}

/**
 * Verifies a Google id_token: checks the JWT signature against Google's JWKS,
 * validates standard claims (iss, aud, exp, iat), and rejects unverified emails.
 */
async function verifyIdToken(idToken: string): Promise<{ email: string }> {
  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: GOOGLE_ISSUER,
    audience: config.googleClientId,
  });

  if (payload.email_verified !== true) {
    throw new Error("id_token email is not verified.");
  }

  if (typeof payload.email !== "string" || !payload.email) {
    throw new Error("id_token does not contain an email claim.");
  }

  return { email: payload.email };
}

/** SHA-256 hash a string and return the hex digest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Exchanges an authorization code for access and refresh tokens using the
 * Authorization Code + PKCE flow.
 *
 * Called from the OAuth callback handler after Google redirects back with `code`.
 *
 * 1. Exchanges the code for Google tokens (including id_token with email).
 * 2. Extracts the user's email from the id_token.
 * 3. Finds or creates the user by email.
 * 4. Stores encrypted OAuth credentials (upsert handles re-authentication).
 * 5. Mints a high-entropy bearer token, stores its hash, and returns the plaintext.
 */
export async function exchangeCodeForTokens(
  db: postgres.Sql,
  {
    code,
    codeVerifier,
    redirectUri,
  }: { code: string; codeVerifier: string; redirectUri: string }
): Promise<ExchangeResult> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const tokens = (await response.json()) as TokenResponse;

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. " +
        "Ensure prompt=consent is set in the authorization URL."
    );
  }

  if (!tokens.id_token) {
    throw new Error(
      "Google did not return an id_token. " +
        "Ensure openid and email scopes are requested."
    );
  }

  const { email } = await verifyIdToken(tokens.id_token);

  const userId = await findOrCreateUserByEmail(db, email);

  const encryptedRefreshToken = encrypt(
    tokens.refresh_token,
    config.tokenEncryptionKey
  );
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await upsertOAuthTokens(db, {
    userId,
    encryptedRefreshToken,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: expiresAt,
  });

  const bearerToken = randomBytes(32).toString("base64url");
  await insertBearerToken(db, { tokenHash: hashToken(bearerToken), userId });

  return { userId, bearerToken };
}

/**
 * Returns a valid access token for the given user, refreshing proactively if
 * the cached token expires within the next 5 minutes.
 *
 * Throws if the user has no token row (not yet authenticated) or if the
 * refresh request to Google fails.
 */
export async function getValidAccessToken(
  db: postgres.Sql,
  userId: string
): Promise<string> {
  const tokenRow = await getOAuthTokens(db, userId);

  if (!tokenRow) {
    throw new Error(
      `No OAuth tokens found for user ${userId}. ` +
        "The user needs to re-authenticate."
    );
  }

  const now = Date.now();
  const expiresAt = tokenRow.accessTokenExpiresAt?.getTime() ?? 0;
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;

  // Use cached access token if it won't expire within the buffer window.
  if (tokenRow.accessToken && expiresAt > now + bufferMs) {
    return tokenRow.accessToken;
  }

  // Proactive refresh: token is near or past expiry.
  return doRefresh(db, userId, tokenRow);
}

/**
 * Forces an immediate access token refresh, bypassing the expiry check.
 *
 * Call this after receiving a 401 from the Gmail API to recover from tokens
 * that became invalid before their local expiry timestamp (e.g. due to
 * revocation, clock skew, or unexpected server-side auth state changes).
 *
 * Throws if the user has no token row or if the Google refresh request fails.
 */
export async function forceRefreshAccessToken(
  db: postgres.Sql,
  userId: string
): Promise<string> {
  const tokenRow = await getOAuthTokens(db, userId);

  if (!tokenRow) {
    throw new Error(
      `No OAuth tokens found for user ${userId}. ` +
        "The user needs to re-authenticate."
    );
  }

  return doRefresh(db, userId, tokenRow);
}

/**
 * Decrypts the stored refresh token, exchanges it for a new access token,
 * persists the result, and returns the new access token.
 *
 * Shared by getValidAccessToken (proactive refresh) and forceRefreshAccessToken
 * (post-401 forced refresh).
 */
async function doRefresh(
  db: postgres.Sql,
  userId: string,
  tokenRow: OAuthTokenRow
): Promise<string> {
  const refreshToken = decrypt(
    tokenRow.encryptedRefreshToken,
    config.tokenEncryptionKey
  );

  const newTokens = await refreshAccessToken(refreshToken);
  const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

  await updateAccessToken(db, {
    userId,
    accessToken: newTokens.access_token,
    accessTokenExpiresAt: newExpiresAt,
  });

  // If Google returned a new refresh token (rotation), re-encrypt and store it.
  if (newTokens.refresh_token) {
    const encryptedRefreshToken = encrypt(
      newTokens.refresh_token,
      config.tokenEncryptionKey
    );
    await upsertOAuthTokens(db, {
      userId,
      encryptedRefreshToken,
      accessToken: newTokens.access_token,
      accessTokenExpiresAt: newExpiresAt,
    });
  }

  return newTokens.access_token;
}

/**
 * Mints a new bearer token for the user identified by the given refresh token.
 *
 * The refresh token is the bearer token previously returned by the token
 * endpoint. This validates that it is still active (not revoked), then mints
 * and stores a new bearer token. The old token remains valid and is not
 * automatically revoked.
 *
 * Returns null if the refresh token is invalid or revoked.
 */
export async function refreshBearerToken(
  db: postgres.Sql,
  refreshToken: string
): Promise<{ bearerToken: string } | null> {
  const userId = await resolveToken(db, hashToken(refreshToken));
  if (!userId) return null;

  const newBearerToken = randomBytes(32).toString("base64url");
  await insertBearerToken(db, { tokenHash: hashToken(newBearerToken), userId });
  return { bearerToken: newBearerToken };
}

/**
 * Calls Google's token endpoint to refresh an access token.
 * Internal helper used by getValidAccessToken.
 */
async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<TokenResponse>;
}
