/**
 * src/oauth/handlers.ts
 *
 * Fastify route handlers for the Google OAuth 2.0 Authorization Code + PKCE flow.
 *
 * Routes:
 *   GET /oauth/authorize  — Initiates the flow; redirects the user to Google.
 *   GET /oauth/callback   — Receives the authorization code; exchanges it for tokens.
 *
 * Flow summary:
 *   1. Claude redirects the user to GET /oauth/authorize.
 *   2. The handler generates a PKCE code_verifier + code_challenge and a CSRF
 *      state value, stores them in the oauth_state table, and redirects the
 *      user to Google's OAuth consent screen.
 *   3. Google redirects to GET /oauth/callback with `code` and `state`.
 *   4. The handler validates the state (CSRF check), retrieves the code_verifier,
 *      exchanges the code for tokens, creates a user record, and stores the
 *      encrypted refresh token.
 *   5. The handler returns a JSON response indicating success. Claude reads the
 *      user ID from the response and uses it as the bearer token for future
 *      MCP requests.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { createOAuthState, consumeOAuthState } from "../db/oauth-state.js";
import { exchangeCodeForTokens } from "./tokens.js";
import { sql } from "../db/index.js";

/** Google's OAuth 2.0 authorization endpoint. */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Gmail modify scope — the only scope this connector requests. */
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

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
   */
  app.get("/oauth/authorize", async (_request: FastifyRequest, reply: FastifyReply) => {
    const state = randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    await createOAuthState(sql, { state, codeVerifier });

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.oauthCallbackUrl,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent", // always request refresh token
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
    return reply.redirect(authUrl);
  });

  /**
   * GET /oauth/callback
   *
   * Receives the Google OAuth redirect. Validates the state parameter, exchanges
   * the authorization code for tokens, creates a user record, and returns the
   * new user ID.
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

      try {
        const userId = await exchangeCodeForTokens(sql, {
          code,
          codeVerifier: stateRow.codeVerifier,
          redirectUri: config.oauthCallbackUrl,
        });

        app.log.info({ userId }, "OAuth flow completed; user connected");

        // Return the user ID as a bearer token for subsequent MCP requests.
        return reply.send({
          success: true,
          userId,
          message:
            "Gmail account connected successfully. " +
            "Use the userId as your bearer token for MCP requests.",
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
}
