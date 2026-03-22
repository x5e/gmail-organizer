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

import { config } from "../config.js";
import { encrypt, decrypt } from "../crypto.js";
import {
  createUser,
  upsertOAuthTokens,
  updateAccessToken,
  getOAuthTokens,
} from "../db/users.js";
import type postgres from "postgres";

/** Google OAuth token endpoint. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** How many seconds before expiry to proactively refresh. */
const REFRESH_BUFFER_SECONDS = 5 * 60; // 5 minutes

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  scope?: string;
}

/**
 * Exchanges an authorization code for access and refresh tokens using the
 * Authorization Code + PKCE flow.
 *
 * Called from the OAuth callback handler after Google redirects back with `code`.
 *
 * @returns The new user ID (UUID) created for this connected account.
 */
export async function exchangeCodeForTokens(
  db: postgres.Sql,
  {
    code,
    codeVerifier,
    redirectUri,
  }: { code: string; codeVerifier: string; redirectUri: string }
): Promise<string> {
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

  const tokens: TokenResponse = await response.json();

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. " +
        "Ensure prompt=consent is set in the authorization URL."
    );
  }

  // Create user record and store encrypted tokens.
  const userId = await createUser(db);
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

  return userId;
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

  // Decrypt the refresh token and get a new access token from Google.
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
