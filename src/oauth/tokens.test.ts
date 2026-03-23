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
import { http, HttpResponse } from "msw";
import { exchangeCodeForTokens, getValidAccessToken, hashToken } from "./tokens.js";
import {
  createTestDb,
  truncateAllTables,
  createTestUserWithTokens,
} from "../test/db-helpers.js";
import { resolveToken } from "../db/users.js";
import { mswServer } from "../mocks/server.js";
import {
  MOCK_ACCESS_TOKEN,
  MOCK_REFRESH_TOKEN,
  MOCK_NEW_ACCESS_TOKEN,
  buildMockIdToken,
} from "../mocks/handlers/google-oauth.js";

const db = createTestDb();

beforeEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await db.end();
});

describe("exchangeCodeForTokens", () => {
  it("creates a user and stores encrypted tokens; returns userId and bearerToken", async () => {
    const { userId, bearerToken } = await exchangeCodeForTokens(db, {
      code: "valid_auth_code",
      codeVerifier: "test-verifier",
      redirectUri: "http://localhost:3000/oauth/callback",
    });

    expect(typeof userId).toBe("string");
    expect(userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(typeof bearerToken).toBe("string");
    expect(bearerToken.length).toBeGreaterThan(0);

    // Verify the user row was created with email.
    const [user] = await db<{ id: string; email: string }[]>`SELECT id, email FROM users WHERE id = ${userId}`;
    expect(user?.id).toBe(userId);
    expect(user?.email).toBe("testuser@example.com");

    // Verify token row has the expected access token.
    const [tokenRow] = await db<{ access_token: string; encrypted_refresh_token: Buffer }[]>`
      SELECT access_token, encrypted_refresh_token
      FROM oauth_tokens WHERE user_id = ${userId}
    `;
    expect(tokenRow?.access_token).toBe(MOCK_ACCESS_TOKEN);
    expect(tokenRow?.encrypted_refresh_token).toBeInstanceOf(Buffer);
    expect(tokenRow!.encrypted_refresh_token.toString()).not.toContain(MOCK_REFRESH_TOKEN);

    // Verify bearer token hash was stored.
    const { hashToken } = await import("./tokens.js");
    const [btRow] = await db`SELECT user_id FROM bearer_tokens WHERE token_hash = ${hashToken(bearerToken)}`;
    expect(btRow?.user_id).toBe(userId);
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
    const [user] = await db<{ id: string }[]>`INSERT INTO users (email) VALUES ('no-tokens@example.com') RETURNING id`;
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

describe("resolveToken", () => {
  it("resolves a valid bearer token to its user ID", async () => {
    const { userId, bearerToken } = await createTestUserWithTokens(db);
    const resolved = await resolveToken(db, hashToken(bearerToken));
    expect(resolved).toBe(userId);
  });

  it("returns null for an unknown token hash", async () => {
    const resolved = await resolveToken(db, hashToken("nonexistent-token"));
    expect(resolved).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const hash = hashToken(bearerToken);

    await db`INSERT INTO token_revocations (token_hash) VALUES (${hash})`;

    const resolved = await resolveToken(db, hash);
    expect(resolved).toBeNull();
  });
});

describe("re-authentication", () => {
  it("reuses the same user when the same email authenticates again", async () => {
    const result1 = await exchangeCodeForTokens(db, {
      code: "valid_auth_code",
      codeVerifier: "verifier-1",
      redirectUri: "http://localhost:3000/oauth/callback",
    });

    const result2 = await exchangeCodeForTokens(db, {
      code: "valid_auth_code",
      codeVerifier: "verifier-2",
      redirectUri: "http://localhost:3000/oauth/callback",
    });

    expect(result1.userId).toBe(result2.userId);
    expect(result1.bearerToken).not.toBe(result2.bearerToken);

    const users = await db`SELECT id FROM users`;
    expect(users).toHaveLength(1);

    const tokens = await db`SELECT token_hash FROM bearer_tokens`;
    expect(tokens).toHaveLength(2);
  });
});

describe("id_token validation", () => {
  function overrideTokenEndpointWith(idToken: string) {
    mswServer.use(
      http.post("https://oauth2.googleapis.com/token", async () => {
        return HttpResponse.json({
          access_token: MOCK_ACCESS_TOKEN,
          expires_in: 3600,
          refresh_token: MOCK_REFRESH_TOKEN,
          id_token: idToken,
          token_type: "Bearer",
        });
      })
    );
  }

  const exchangeArgs = {
    code: "valid_auth_code",
    codeVerifier: "test-verifier",
    redirectUri: "http://localhost:3000/oauth/callback",
  } as const;

  it("rejects a token with email_verified: false", async () => {
    const badToken = await buildMockIdToken("unverified@example.com", {
      email_verified: false,
    });
    overrideTokenEndpointWith(badToken);

    await expect(exchangeCodeForTokens(db, exchangeArgs)).rejects.toThrow(
      /email is not verified/
    );
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const badToken = await buildMockIdToken("expired@example.com", {
      iat: past - 3600,
      exp: past,
    });
    overrideTokenEndpointWith(badToken);

    await expect(exchangeCodeForTokens(db, exchangeArgs)).rejects.toThrow(
      /exp/i
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const badToken = await buildMockIdToken("wrong-aud@example.com", {
      aud: "not-our-client-id",
    });
    overrideTokenEndpointWith(badToken);

    await expect(exchangeCodeForTokens(db, exchangeArgs)).rejects.toThrow(
      /aud/i
    );
  });
});
