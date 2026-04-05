/**
 * src/oauth/handlers.ts
 *
 * Fastify route handlers for the Google OAuth 2.0 Authorization Code + PKCE flow.
 *
 * Routes:
 *   GET  /oauth/authorize  — Initiates the flow; redirects the user to Google.
 *   GET  /oauth/callback   — Receives the Google authorization code from Google.
 *   POST /oauth/token      — MCP client exchanges server-issued code for bearer token.
 *
 * Two flows are supported:
 *
 * Legacy (direct browser visit, no redirect_uri):
 *   1. User visits GET /oauth/authorize (no MCP params).
 *   2. Server redirects to Google.
 *   3. Google redirects to GET /oauth/callback.
 *   4. Callback exchanges code with Google, mints bearer token, returns JSON.
 *
 * MCP-compliant (RFC 6749 + PKCE, MCP client drives token exchange):
 *   1. MCP client opens browser to GET /oauth/authorize?redirect_uri=...&code_challenge=...
 *   2. Server stores client params in oauth_state, redirects to Google.
 *   3. Google redirects to GET /oauth/callback.
 *   4. Callback issues a short-lived server authorization code and redirects to
 *      the MCP client's redirect_uri: <redirect_uri>?code=<server-code>&state=<client-state>
 *   5. MCP client calls POST /oauth/token with the server code + PKCE verifier.
 *   6. Server validates PKCE, exchanges Google code, mints bearer token, returns
 *      standard OAuth token response: { access_token, token_type, expires_in }.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { createOAuthState, consumeOAuthState } from "../db/oauth-state.js";
import { createAuthorizationCode, consumeAuthorizationCode } from "../db/authorization-codes.js";
import { exchangeCodeForTokens, refreshBearerToken } from "./tokens.js";
import { sql } from "../db/index.js";

/** Google's OAuth 2.0 authorization endpoint. */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** OAuth scopes: Gmail modify for inbox operations, openid+email for user identity. */
const OAUTH_SCOPES = "https://www.googleapis.com/auth/gmail.modify openid email";

/**
 * Generates a cryptographically random PKCE code verifier (43-128 chars,
 * unreserved URL characters as per RFC 7636 Section 4.1).
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url").slice(0, 96);
}

/**
 * Derives the S256 code challenge from a code verifier.
 * challenge = BASE64URL(SHA256(ASCII(verifier)))
 */
function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Registers the OAuth route handlers on the Fastify instance.
 */
export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /oauth/authorize
   *
   * Initiates the OAuth flow. Generates PKCE state, stores it in the DB, and
   * redirects the user to Google's consent screen.
   *
   * Optional MCP client query parameters (all present together in MCP flow):
   *   client_id            — MCP client identifier (accepted but not validated)
   *   redirect_uri         — Where to redirect after callback (triggers MCP flow)
   *   code_challenge       — Client's PKCE code challenge (S256)
   *   code_challenge_method — Must be "S256" if present
   *   state                — Client's opaque state value (echoed back at redirect)
   */
  app.get<{
    Querystring: {
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      state?: string;
    };
  }>("/oauth/authorize", async (request: FastifyRequest<{
    Querystring: {
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      state?: string;
    };
  }>, reply: FastifyReply) => {
    const {
      redirect_uri: mcpRedirectUri,
      code_challenge: mcpCodeChallenge,
      code_challenge_method,
      state: mcpClientState,
    } = request.query;

    // Only S256 is supported; reject any other method if explicitly specified.
    if (code_challenge_method && code_challenge_method !== "S256") {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Only code_challenge_method=S256 is supported.",
      });
    }

    // When the MCP flow is active (redirect_uri present), code_challenge is
    // required. Without it, the callback would later attempt to insert NULL
    // into the NOT NULL authorization_codes.code_challenge column, turning
    // bad client input into a 500 after the user has already completed Google auth.
    if (mcpRedirectUri && !mcpCodeChallenge) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "code_challenge is required when redirect_uri is provided.",
      });
    }

    // csrfState is the server-generated CSRF token sent to Google.
    // It is distinct from the MCP client's own state (mcpClientState).
    const csrfState = randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    await createOAuthState(sql, {
      state: csrfState,
      codeVerifier,
      ...(mcpRedirectUri && {
        mcpRedirectUri,
        mcpCodeChallenge,
        mcpClientState,
      }),
    });

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.oauthCallbackUrl,
      response_type: "code",
      scope: OAUTH_SCOPES,
      access_type: "offline",
      prompt: "consent", // always request refresh token
      state: csrfState,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
    return reply.redirect(authUrl);
  });

  /**
   * GET /oauth/callback
   *
   * Receives the Google OAuth redirect. Validates the state parameter, then
   * branches based on whether the flow originated from an MCP client:
   *
   * MCP flow (stateRow.mcpRedirectUri is set):
   *   - Generates a short-lived server authorization code.
   *   - Stores it in authorization_codes alongside the Google code.
   *   - Redirects the browser to the MCP client's redirect_uri.
   *
   * Legacy flow (no mcpRedirectUri):
   *   - Exchanges the Google code for tokens immediately.
   *   - Returns the bearer token as JSON.
   */
  app.get(
    "/oauth/callback",
    async (
      request: FastifyRequest<{
        Querystring: { code?: string; state?: string; error?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { code, state, error } = request.query;

      // Handle user-denied or other error responses from Google.
      if (error) {
        app.log.warn({ error }, "OAuth authorization error from Google");
        return reply.status(400).send({
          error: "oauth_error",
          message: `Authorization failed: ${error}`,
        });
      }

      if (!code || !state) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "Missing code or state parameter in OAuth callback.",
        });
      }

      // Validate the state parameter (CSRF check) and retrieve the code_verifier.
      const stateRow = await consumeOAuthState(sql, state);
      if (!stateRow) {
        app.log.warn({ state }, "OAuth callback with unknown or expired state");
        return reply.status(400).send({
          error: "invalid_state",
          message:
            "OAuth state parameter is invalid or expired. Please restart the authorization flow.",
        });
      }

      // ── MCP flow ────────────────────────────────────────────────────────────
      if (stateRow.mcpRedirectUri) {
        const serverCode = randomBytes(32).toString("base64url");

        await createAuthorizationCode(sql, {
          code: serverCode,
          googleCode: code,
          googleCodeVerifier: stateRow.codeVerifier,
          redirectUri: stateRow.mcpRedirectUri,
          codeChallenge: stateRow.mcpCodeChallenge!,
        });

        const redirectUrl = new URL(stateRow.mcpRedirectUri);
        redirectUrl.searchParams.set("code", serverCode);
        if (stateRow.mcpClientState) {
          redirectUrl.searchParams.set("state", stateRow.mcpClientState);
        }

        app.log.info("OAuth MCP callback: issued server code, redirecting to client");
        return reply.redirect(redirectUrl.toString());
      }

      // ── Legacy flow ──────────────────────────────────────────────────────────
      try {
        const { userId, bearerToken } = await exchangeCodeForTokens(sql, {
          code,
          codeVerifier: stateRow.codeVerifier,
          redirectUri: config.oauthCallbackUrl,
        });

        app.log.info({ userId }, "OAuth flow completed; user connected");

        return reply.send({
          success: true,
          token: bearerToken,
          message:
            "Gmail account connected successfully. " +
            "Use the token as your Bearer token for MCP requests: " +
            "Authorization: Bearer <token>",
        });
      } catch (err) {
        app.log.error({ err }, "Token exchange failed");
        return reply.status(500).send({
          error: "token_exchange_failed",
          message:
            "Failed to exchange authorization code for tokens. Please try again.",
        });
      }
    }
  );

  /**
   * POST /oauth/register
   *
   * RFC 7591 Dynamic Client Registration endpoint.
   *
   * MCP clients (e.g. Claude Cowork) that lack a pre-registered client_id call
   * this endpoint before starting the authorization flow. We accept any valid
   * registration request and return a freshly generated client_id.
   *
   * The client_id is not stored or validated in subsequent requests — the
   * authorize and token endpoints already accept client_id without checking it —
   * so this endpoint only needs to satisfy the SDK's schema requirements.
   */
  app.post("/oauth/register", async (_request, reply) => {
    return reply.status(201).send({
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  /**
   * POST /oauth/token
   *
   * MCP client token endpoint (RFC 6749 §4.1.3).
   *
   * Exchanges a server-issued authorization code for a bearer token. The client
   * must prove possession of the original PKCE code_verifier. Returns a standard
   * OAuth 2.0 token response.
   *
   * Accepts: application/json body with:
   *   grant_type    — must be "authorization_code"
   *   code          — server-issued code from the callback redirect
   *   redirect_uri  — must match the one used in /oauth/authorize
   *   code_verifier — PKCE verifier (SHA256 must equal stored code_challenge)
   *   client_id     — MCP client identifier (accepted but not validated)
   */
  app.post<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id?: string;
      refresh_token?: string;
    };
  }>("/oauth/token", async (request: FastifyRequest<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id?: string;
      refresh_token?: string;
    };
  }>, reply: FastifyReply) => {
    const { grant_type, code, redirect_uri, code_verifier, refresh_token } = request.body ?? {};

    if (grant_type !== "authorization_code" && grant_type !== "refresh_token") {
      return reply.status(400).send({
        error: "unsupported_grant_type",
        message: "Supported grant types: authorization_code, refresh_token.",
      });
    }

    // ── refresh_token grant ──────────────────────────────────────────────────
    if (grant_type === "refresh_token") {
      if (!refresh_token) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "Missing required parameter: refresh_token.",
        });
      }

      const result = await refreshBearerToken(sql, refresh_token);
      if (!result) {
        return reply.status(400).send({
          error: "invalid_grant",
          message: "Refresh token is invalid or revoked.",
        });
      }

      app.log.info("OAuth token endpoint: bearer token refreshed");

      return reply.send({
        access_token: result.bearerToken,
        refresh_token: result.bearerToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // ── authorization_code grant ─────────────────────────────────────────────
    if (!code || !redirect_uri || !code_verifier) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Missing required parameters: code, redirect_uri, code_verifier.",
      });
    }

    const row = await consumeAuthorizationCode(sql, code);
    if (!row) {
      return reply.status(400).send({
        error: "invalid_grant",
        message: "Authorization code is invalid or expired.",
      });
    }

    // Validate redirect_uri matches what was registered during /oauth/authorize.
    if (row.redirectUri !== redirect_uri) {
      return reply.status(400).send({
        error: "invalid_grant",
        message: "redirect_uri does not match.",
      });
    }

    // PKCE verification: SHA256(code_verifier) base64url must equal stored code_challenge.
    const computedChallenge = createHash("sha256")
      .update(code_verifier)
      .digest("base64url");
    if (computedChallenge !== row.codeChallenge) {
      return reply.status(400).send({
        error: "invalid_grant",
        message: "PKCE verification failed.",
      });
    }

    try {
      const { bearerToken } = await exchangeCodeForTokens(sql, {
        code: row.googleCode,
        codeVerifier: row.googleCodeVerifier,
        redirectUri: config.oauthCallbackUrl,
      });

      app.log.info("OAuth token endpoint: bearer token issued");

      return reply.send({
        access_token: bearerToken,
        refresh_token: bearerToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    } catch (err) {
      app.log.error({ err }, "Token exchange failed in /oauth/token");
      return reply.status(500).send({
        error: "server_error",
        message: "Failed to exchange authorization code for tokens. Please try again.",
      });
    }
  });
}
