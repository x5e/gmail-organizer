/**
 * src/oauth/handlers.integration.test.ts
 *
 * Integration tests for the full OAuth flow (authorize + callback routes).
 *
 * Covers:
 *   - GET /oauth/authorize: redirects to Google with correct params
 *   - GET /oauth/callback: handles valid code + state → creates user, stores tokens
 *   - GET /oauth/callback: handles error param from Google
 *   - GET /oauth/callback: handles invalid/missing state (CSRF protection)
 *   - GET /oauth/callback: handles invalid authorization code
 *   - GET /oauth/callback: handles missing code/state params
 *   - GET /health: returns 200 ok
 *
 * Uses real Fastify server + real Postgres (test container).
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { buildApp } from "../server.js";
import { createTestDb, truncateAllTables } from "../test/db-helpers.js";
import type { FastifyInstance } from "fastify";

const db = createTestDb();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
  });
});

describe("GET /oauth/authorize", () => {
  it("redirects to Google OAuth with required parameters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers["location"] as string;
    expect(location).toBeDefined();
    expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");

    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("access_type")).toBe("offline");
    expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
    expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirectUrl.searchParams.get("scope")).toContain("gmail.modify");
    expect(redirectUrl.searchParams.get("scope")).toContain("openid");
    expect(redirectUrl.searchParams.get("scope")).toContain("email");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();
    expect(redirectUrl.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("stores the oauth state in the database", async () => {
    await app.inject({ method: "GET", url: "/oauth/authorize" });

    const rows = await db`SELECT state FROM oauth_state`;
    expect(rows).toHaveLength(1);
  });
});

describe("GET /oauth/callback", () => {
  it("completes the flow with valid code and state, returns a bearer token", async () => {
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const location = authResponse.headers["location"] as string;
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state")!;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state}`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    const body = JSON.parse(callbackResponse.body);
    expect(body.success).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.userId).toBeUndefined();
  });

  it("creates a user, oauth token row, and bearer token in the database", async () => {
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const state = new URL(authResponse.headers["location"] as string).searchParams.get("state")!;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state}`,
    });
    const { token } = JSON.parse(callbackResponse.body);

    const [user] = await db<{ id: string; email: string }[]>`SELECT id, email FROM users LIMIT 1`;
    expect(user).toBeDefined();
    expect(user!.email).toBe("testuser@example.com");

    const [oauthRow] = await db`SELECT user_id FROM oauth_tokens WHERE user_id = ${user!.id}`;
    expect(oauthRow).toBeDefined();

    const { hashToken } = await import("./tokens.js");
    const [btRow] = await db`SELECT user_id FROM bearer_tokens WHERE token_hash = ${hashToken(token)}`;
    expect(btRow).toBeDefined();
    expect(btRow!.user_id).toBe(user!.id);
  });

  it("consumes (deletes) the oauth state row after the callback", async () => {
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const state = new URL(authResponse.headers["location"] as string).searchParams.get("state")!;

    await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state}`,
    });

    // The state row must have been consumed.
    const rows = await db`SELECT state FROM oauth_state WHERE state = ${state}`;
    expect(rows).toHaveLength(0);
  });

  it("returns 400 when Google sends an error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback?error=access_denied",
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("oauth_error");
  });

  it("returns 400 for unknown/expired state (CSRF protection)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback?code=some_code&state=invalid_state_xyz",
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("invalid_state");
  });

  it("returns 400 when code or state is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/callback",
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("invalid_request");
  });

  it("re-authentication with same email reuses the user but creates a new token", async () => {
    // First auth flow
    const auth1 = await app.inject({ method: "GET", url: "/oauth/authorize" });
    const state1 = new URL(auth1.headers["location"] as string).searchParams.get("state")!;
    const cb1 = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state1}`,
    });
    const { token: token1 } = JSON.parse(cb1.body);

    // Second auth flow (same email from MSW mock)
    const auth2 = await app.inject({ method: "GET", url: "/oauth/authorize" });
    const state2 = new URL(auth2.headers["location"] as string).searchParams.get("state")!;
    const cb2 = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state2}`,
    });
    const { token: token2 } = JSON.parse(cb2.body);

    expect(token1).not.toBe(token2);

    // Only one user row should exist (same email).
    const users = await db`SELECT id FROM users`;
    expect(users).toHaveLength(1);

    // Both bearer tokens should be valid.
    const bearerTokens = await db`SELECT token_hash FROM bearer_tokens`;
    expect(bearerTokens).toHaveLength(2);
  });

  it("returns 500 when token exchange fails (invalid code)", async () => {
    // Create a valid state row first.
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const state = new URL(authResponse.headers["location"] as string).searchParams.get("state")!;

    // Use the invalid_code that our MSW handler rejects.
    const response = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=invalid_code&state=${state}`,
    });
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("token_exchange_failed");
  });
});
