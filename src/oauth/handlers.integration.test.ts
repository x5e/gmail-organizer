/**
 * src/oauth/handlers.integration.test.ts
 *
 * Integration tests for the full OAuth flow (authorize + callback + token routes).
 *
 * Covers:
 *   - GET /.well-known/oauth-authorization-server: RFC 8414 metadata
 *   - GET /oauth/authorize: redirects to Google with correct params (legacy + MCP)
 *   - GET /oauth/callback: handles valid code + state (legacy → JSON bearer token)
 *   - GET /oauth/callback: handles MCP flow → redirects to client redirect_uri
 *   - GET /oauth/callback: handles error param from Google
 *   - GET /oauth/callback: handles invalid/missing state (CSRF protection)
 *   - GET /oauth/callback: handles invalid authorization code
 *   - GET /oauth/callback: handles missing code/state params
 *   - POST /oauth/token: full MCP flow (authorize → callback → token → /mcp works)
 *   - POST /oauth/token: error cases (expired, bad redirect_uri, bad verifier, invalid code)
 *   - GET /health: returns 200 ok
 *
 * Uses real Fastify server + real Postgres (test container).
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generates a PKCE code_verifier + code_challenge pair (S256). */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns 200 with all required RFC 8414 fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(response.body);
    expect(typeof body.issuer).toBe("string");
    expect(body.authorization_endpoint).toContain("/oauth/authorize");
    expect(body.token_endpoint).toContain("/oauth/token");
    expect(body.registration_endpoint).toContain("/oauth/register");
    expect(body.response_types_supported).toContain("code");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.scopes_supported).toContain("gmail:read");
    expect(body.scopes_supported).toContain("gmail:modify");
  });
});

describe("POST /oauth/register", () => {
  it("returns 201 with a valid client_id and echoes back client metadata", async () => {
    const redirectUris = ["https://claude.ai/oauth/callback"];
    const response = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: { "Content-Type": "application/json" },
      payload: {
        client_name: "Claude Cowork",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.length).toBeGreaterThan(0);
    expect(typeof body.client_id_issued_at).toBe("number");
    // redirect_uris must be echoed back — the MCP SDK's OAuthClientInformationFullSchema
    // merges OAuthClientMetadataSchema (which requires redirect_uris) and will throw a
    // Zod parse error if redirect_uris is absent, silently aborting the auth flow.
    expect(body.redirect_uris).toEqual(redirectUris);
    expect(body.client_name).toBe("Claude Cowork");
  });

  it("returns a different client_id on each call", async () => {
    const payload = { redirect_uris: ["https://example.com/cb"] };
    const r1 = await app.inject({ method: "POST", url: "/oauth/register", payload });
    const r2 = await app.inject({ method: "POST", url: "/oauth/register", payload });
    expect(JSON.parse(r1.body).client_id).not.toBe(JSON.parse(r2.body).client_id);
  });
});

describe("OAuth discovery chain (what a new MCP client like Cowork does)", () => {
  /**
   * Simulates the exact sequence an MCP client follows when first connecting:
   *   1. Hit the MCP endpoint → 401 with WWW-Authenticate
   *   2. Follow WWW-Authenticate → resource metadata (RFC 9728)
   *   3. Follow authorization_servers → auth server metadata (RFC 8414)
   *   4. Find registration_endpoint → dynamic client registration (RFC 7591)
   *
   * If any link in this chain breaks, clients cannot connect.
   */
  it("discovery chain: 401 → resource metadata → auth server metadata → registration endpoint", async () => {
    // Step 1: hit GET /mcp without a token, expect 401 with a resource_metadata hint
    const mcpRes = await app.inject({ method: "GET", url: "/mcp", headers: { Accept: "text/event-stream" } });
    expect(mcpRes.statusCode).toBe(401);
    const wwwAuth = mcpRes.headers["www-authenticate"] as string;
    expect(wwwAuth).toBeDefined();

    // Extract the resource_metadata URL from the WWW-Authenticate header
    const metadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
    expect(metadataMatch).not.toBeNull();
    const resourceMetadataPath = new URL(metadataMatch![1]!).pathname;

    // Step 2: fetch the resource metadata
    const rmRes = await app.inject({ method: "GET", url: resourceMetadataPath });
    expect(rmRes.statusCode).toBe(200);
    const rm = JSON.parse(rmRes.body);
    expect(Array.isArray(rm.authorization_servers)).toBe(true);
    expect(rm.authorization_servers.length).toBeGreaterThan(0);

    // Step 3: fetch the authorization server metadata from the advertised server
    const asRes = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(asRes.statusCode).toBe(200);
    const as = JSON.parse(asRes.body);
    expect(as.registration_endpoint).toBeDefined();

    // Step 4: verify the registration_endpoint is reachable and works
    const regPath = new URL(as.registration_endpoint).pathname;
    const regRes = await app.inject({
      method: "POST",
      url: regPath,
      headers: { "Content-Type": "application/json" },
      payload: { client_name: "Test MCP Client", redirect_uris: ["https://client.example.com/cb"] },
    });
    expect(regRes.statusCode).toBe(201);
    expect(typeof JSON.parse(regRes.body).client_id).toBe("string");
  });

  it("full Cowork-style flow: register → authorize → callback → token → GET /mcp succeeds", async () => {
    const { verifier, challenge } = generatePkce();
    const redirectUri = "https://mcp-client.example.com/callback";

    // Register as a new client (what Cowork does when it has no client_id yet)
    const regRes = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: { "Content-Type": "application/json" },
      payload: {
        client_name: "Claude Cowork",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = JSON.parse(regRes.body);

    // Authorize using the registered client_id
    const authRes = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=mystate`,
    });
    expect(authRes.statusCode).toBe(302);
    const csrfState = new URL(authRes.headers["location"] as string).searchParams.get("state")!;

    // Callback (Google returns control to our server)
    const cbRes = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${csrfState}`,
    });
    expect(cbRes.statusCode).toBe(302);
    const serverCode = new URL(cbRes.headers["location"] as string).searchParams.get("code")!;
    expect(serverCode).toBeTruthy();

    // Exchange the server code for a bearer token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id,
      },
    });
    expect(tokenRes.statusCode).toBe(200);
    const { access_token } = JSON.parse(tokenRes.body);
    expect(typeof access_token).toBe("string");

    // Use the token on POST /mcp — must authenticate successfully (not 401)
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });
    expect(mcpRes.statusCode).not.toBe(401);
    expect(mcpRes.statusCode).not.toBe(404);
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

  it("stores MCP client params in the database when redirect_uri is provided", async () => {
    const { challenge } = generatePkce();
    const redirectUri = "https://mcp-client.example.com/callback";
    const clientState = "opaque-client-state";

    await app.inject({
      method: "GET",
      url: `/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${clientState}`,
    });

    const rows = await db<
      { mcp_redirect_uri: string; mcp_code_challenge: string; mcp_client_state: string }[]
    >`SELECT mcp_redirect_uri, mcp_code_challenge, mcp_client_state FROM oauth_state`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mcp_redirect_uri).toBe(redirectUri);
    expect(rows[0]!.mcp_code_challenge).toBe(challenge);
    expect(rows[0]!.mcp_client_state).toBe(clientState);
  });

  it("returns 400 for unsupported code_challenge_method", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize?redirect_uri=https://example.com&code_challenge=abc&code_challenge_method=plain",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("invalid_request");
  });

  it("returns 400 when redirect_uri is present but code_challenge is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize?redirect_uri=https://mcp-client.example.com/callback",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("invalid_request");
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

describe("MCP OAuth flow (PKCE token endpoint)", () => {
  const MCP_REDIRECT_URI = "https://mcp-client.example.com/callback";
  const MCP_CLIENT_STATE = "client-opaque-state-xyz";

  /** Runs the authorize + callback steps and returns the server-issued code. */
  async function doAuthorizeAndCallback(
    challenge: string,
    clientState?: string
  ): Promise<{ serverCode: string; returnedState: string | null }> {
    const stateParam = clientState ? `&state=${clientState}` : "";
    const authRes = await app.inject({
      method: "GET",
      url: `/oauth/authorize?redirect_uri=${encodeURIComponent(MCP_REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256${stateParam}`,
    });
    expect(authRes.statusCode).toBe(302);

    const csrfState = new URL(authRes.headers["location"] as string).searchParams.get("state")!;
    const cbRes = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${csrfState}`,
    });
    expect(cbRes.statusCode).toBe(302);

    const redirectLocation = cbRes.headers["location"] as string;
    const redirectUrl = new URL(redirectLocation);
    return {
      serverCode: redirectUrl.searchParams.get("code")!,
      returnedState: redirectUrl.searchParams.get("state"),
    };
  }

  it("callback redirects to client redirect_uri with server code and echoed state", async () => {
    const { challenge } = generatePkce();
    const { serverCode, returnedState } = await doAuthorizeAndCallback(challenge, MCP_CLIENT_STATE);

    expect(serverCode).toBeTruthy();
    expect(returnedState).toBe(MCP_CLIENT_STATE);
  });

  it("POST /oauth/token accepts application/x-www-form-urlencoded (as the MCP SDK sends it)", async () => {
    const { verifier, challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge);

    // Build a form-encoded body exactly as the MCP SDK's executeTokenRequest does
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: serverCode,
      redirect_uri: MCP_REDIRECT_URI,
      code_verifier: verifier,
    });

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.access_token).toBe("string");
    expect(body.token_type).toBe("Bearer");
  });

  it("full flow: authorize → callback → POST /oauth/token → bearer token works on /mcp", async () => {
    const { verifier, challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge, MCP_CLIENT_STATE);

    // POST /oauth/token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
        client_id: "mcp-client",
      },
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokenBody = JSON.parse(tokenRes.body);
    expect(typeof tokenBody.access_token).toBe("string");
    expect(typeof tokenBody.refresh_token).toBe("string");
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);

    // Bearer token must authenticate against POST /mcp
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });
    expect(mcpRes.statusCode).not.toBe(401);
  });

  it("POST /oauth/token returns 400 for expired code", async () => {
    const { verifier } = generatePkce();
    const expiredCode = randomBytes(16).toString("hex");

    // Insert an already-expired code directly.
    await db`
      INSERT INTO authorization_codes
        (code, google_code, google_code_verifier, redirect_uri, code_challenge, created_at)
      VALUES
        (${expiredCode}, 'gc', 'gcv', ${MCP_REDIRECT_URI}, 'cc', now() - interval '10 minutes')
    `;

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: expiredCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token returns 400 for mismatched redirect_uri", async () => {
    const { verifier, challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge);

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: "https://wrong.example.com/callback",
        code_verifier: verifier,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token returns 400 for wrong code_verifier", async () => {
    const { challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge);

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: "wrong-verifier-that-does-not-match",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token returns 400 for nonexistent code", async () => {
    const { verifier } = generatePkce();

    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: "nonexistent-code-xyz",
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token returns 400 for unsupported grant_type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: { grant_type: "client_credentials" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });

  it("POST /oauth/token returns 400 when required parameters are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: { grant_type: "authorization_code" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  it("server code cannot be reused after successful token exchange", async () => {
    const { verifier, challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge);

    // First exchange succeeds
    const res1 = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
      },
    });
    expect(res1.statusCode).toBe(200);

    // Second exchange with the same code must fail (code was consumed)
    const res2 = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
      },
    });
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token with grant_type=refresh_token issues a new bearer token", async () => {
    const { verifier, challenge } = generatePkce();
    const { serverCode } = await doAuthorizeAndCallback(challenge);

    // Get an initial access + refresh token
    const tokenRes = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: {
        grant_type: "authorization_code",
        code: serverCode,
        redirect_uri: MCP_REDIRECT_URI,
        code_verifier: verifier,
      },
    });
    const { refresh_token } = JSON.parse(tokenRes.body);

    // Refresh to get a new token
    const refreshRes = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: { grant_type: "refresh_token", refresh_token },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = JSON.parse(refreshRes.body);
    expect(typeof refreshBody.access_token).toBe("string");
    expect(typeof refreshBody.refresh_token).toBe("string");
    expect(refreshBody.token_type).toBe("Bearer");
    expect(refreshBody.expires_in).toBe(3600);
    // New token is different from the original
    expect(refreshBody.access_token).not.toBe(refresh_token);

    // New token authenticates against /mcp
    const mcpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${refreshBody.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });
    expect(mcpRes.statusCode).not.toBe(401);
  });

  it("POST /oauth/token returns 400 for invalid refresh_token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: { grant_type: "refresh_token", refresh_token: "not-a-valid-token" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  it("POST /oauth/token returns 400 when refresh_token param is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/json" },
      payload: { grant_type: "refresh_token" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  it("legacy flow: callback without MCP params still returns JSON bearer token", async () => {
    const authRes = await app.inject({ method: "GET", url: "/oauth/authorize" });
    const csrfState = new URL(authRes.headers["location"] as string).searchParams.get("state")!;

    const cbRes = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=valid_auth_code&state=${csrfState}`,
    });
    expect(cbRes.statusCode).toBe(200);
    const body = JSON.parse(cbRes.body);
    expect(body.success).toBe(true);
    expect(typeof body.token).toBe("string");
  });
});
