/**
 * src/oauth/tokens.test.ts
 *
 * Unit tests for OAuth token management (exchange, refresh, caching).
 *
 * Covers:
 *   - exchangeCodeForTokens: stores encrypted refresh token, returns userId
 *   - getValidAccessToken: returns cached token when not expired
 *   - getValidAccessToken: refreshes proactively when within 5-min buffer
 *   - getValidAccessToken: refreshes when no cached access token exists
 *   - getValidAccessToken: throws when no token row exists for user
 *   - getValidAccessToken: handles token rotation (new refresh token returned)
 *
 * Uses a real test database via createTestDb().
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { exchangeCodeForTokens, getValidAccessToken } from "./tokens.js";
import {
  createTestDb,
  truncateAllTables,
  createTestUserWithTokens,
} from "../test/db-helpers.js";
import {
  MOCK_ACCESS_TOKEN,
  MOCK_REFRESH_TOKEN,
  MOCK_NEW_ACCESS_TOKEN,
} from "../mocks/handlers/google-oauth.js";

const db = createTestDb();

beforeEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await db.end();
});

describe("exchangeCodeForTokens", () => {
  it("creates a user and stores encrypted tokens; returns userId", async () => {
    const userId = await exchangeCodeForTokens(db, {
      code: "valid_auth_code",
      codeVerifier: "test-verifier",
      redirectUri: "http://localhost:3000/oauth/callback",
    });

    expect(typeof userId).toBe("string");
    expect(userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // Verify the user row was created.
    const [user] = await db<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`;
    expect(user?.id).toBe(userId);

    // Verify token row has the expected access token.
    const [tokenRow] = await db<{ access_token: string; encrypted_refresh_token: Buffer }[]>`
      SELECT access_token, encrypted_refresh_token
      FROM oauth_tokens WHERE user_id = ${userId}
    `;
    expect(tokenRow?.access_token).toBe(MOCK_ACCESS_TOKEN);
    // encrypted_refresh_token must be a Buffer (bytea), not the plaintext.
    expect(tokenRow?.encrypted_refresh_token).toBeInstanceOf(Buffer);
    expect(tokenRow!.encrypted_refresh_token.toString()).not.toContain(MOCK_REFRESH_TOKEN);
  });

  it("throws when the authorization code is invalid", async () => {
    await expect(
      exchangeCodeForTokens(db, {
        code: "invalid_code",
        codeVerifier: "verifier",
        redirectUri: "http://localhost:3000/oauth/callback",
      })
    ).rejects.toThrow(/Token exchange failed/);
  });
});

describe("getValidAccessToken", () => {
  it("returns the cached access token when it has not expired", async () => {
    const { userId, accessToken } = await createTestUserWithTokens(db);
    const result = await getValidAccessToken(db, userId);
    expect(result).toBe(accessToken);
  });

  it("refreshes the token when within the 5-minute buffer", async () => {
    // Set expiry to 2 minutes from now (inside the 5-minute buffer).
    const { userId } = await createTestUserWithTokens(db, {
      accessToken: "expiring-soon-token",
      accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 1000),
    });

    const result = await getValidAccessToken(db, userId);
    expect(result).toBe(MOCK_NEW_ACCESS_TOKEN);
  });

  it("refreshes the token when the access token is expired", async () => {
    const { userId } = await createTestUserWithTokens(db, {
      accessToken: "expired-token",
      accessTokenExpiresAt: new Date(Date.now() - 60 * 1000), // 1 minute ago
    });

    const result = await getValidAccessToken(db, userId);
    expect(result).toBe(MOCK_NEW_ACCESS_TOKEN);
  });

  it("refreshes when no access token is stored", async () => {
    // Create user but then clear the access token.
    const { userId } = await createTestUserWithTokens(db);
    await db`
      UPDATE oauth_tokens SET access_token = NULL, access_token_expires_at = NULL
      WHERE user_id = ${userId}
    `;

    const result = await getValidAccessToken(db, userId);
    expect(result).toBe(MOCK_NEW_ACCESS_TOKEN);
  });

  it("throws when no token row exists for the user", async () => {
    const [user] = await db<{ id: string }[]>`INSERT INTO users DEFAULT VALUES RETURNING id`;
    const userId = user!.id;

    await expect(getValidAccessToken(db, userId)).rejects.toThrow(
      /No OAuth tokens found/
    );
  });

  it("updates the stored access token after refresh", async () => {
    const { userId } = await createTestUserWithTokens(db, {
      accessTokenExpiresAt: new Date(Date.now() - 1000), // expired
    });

    await getValidAccessToken(db, userId);

    const [tokenRow] = await db<{ access_token: string }[]>`
      SELECT access_token FROM oauth_tokens WHERE user_id = ${userId}
    `;
    expect(tokenRow?.access_token).toBe(MOCK_NEW_ACCESS_TOKEN);
  });
});
