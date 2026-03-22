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
  it("completes the flow with valid code and state", async () => {
    // First, initiate the flow to create a state row.
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const location = authResponse.headers["location"] as string;
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state")!;

    // Simulate Google's callback.
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state}`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    const body = JSON.parse(callbackResponse.body);
    expect(body.success).toBe(true);
    expect(body.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("creates a user and token row in the database", async () => {
    const authResponse = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
    });
    const state = new URL(authResponse.headers["location"] as string).searchParams.get("state")!;

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${state}`,
    });
    const { userId } = JSON.parse(callbackResponse.body);

    const [user] = await db<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`;
    expect(user?.id).toBe(userId);

    const [tokenRow] = await db`SELECT user_id FROM oauth_tokens WHERE user_id = ${userId}`;
    expect(tokenRow).toBeDefined();
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
