/**
 * src/server.ts
 *
 * Application entry point. Builds and starts the Fastify HTTP server.
 *
 * Routes:
 *   POST /mcp             — Main MCP endpoint (Streamable HTTP, stateless)
 *   GET  /oauth/authorize — Initiates the Google OAuth flow
 *   GET  /oauth/callback  — Receives the Google OAuth redirect
 *   GET  /health          — Health check for load balancers / uptime monitors
 *
 * On startup:
 *   1. Runs database migrations (ensures schema is current).
 *   2. Registers Fastify plugins (CORS, rate limiting).
 *   3. Registers routes.
 *   4. Starts listening on PORT (default 3000).
 *
 * Graceful shutdown: closes the database pool and HTTP server on SIGTERM/SIGINT.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { sql, closeDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { registerOAuthRoutes } from "./oauth/handlers.js";
import { createMcpRequestHandler } from "./mcp.js";
import { hashToken } from "./oauth/tokens.js";

/** Builds the Fastify application (without starting it). Exported for testing. */
export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Redact sensitive fields from logs.
      redact: [
        "req.headers.authorization",
        "*.access_token",
        "*.refresh_token",
        "*.encrypted_refresh_token",
      ],
    },
  });

  // ─── Plugins ────────────────────────────────────────────────────────────────

  await app.register(cors, {
    // Set ALLOWED_ORIGIN to restrict which domains can make requests.
    // Defaults to allowing all origins; set to your MCP client's domain in production.
    origin: process.env["ALLOWED_ORIGIN"] ?? true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    // Expose WWW-Authenticate so browser-based MCP clients can read the header
    // from a cross-origin 401 response and follow the OAuth discovery chain.
    exposedHeaders: ["WWW-Authenticate"],
  });

  await app.register(rateLimit, {
    max: 100, // requests
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      // Rate-limit by the hash of the bearer token so that the raw token is
      // never stored in the rate-limiter's in-memory map.
      const auth = request.headers.authorization ?? "";
      if (auth.startsWith("Bearer ")) {
        return hashToken(auth.slice(7));
      }
      return request.ip;
    },
  });

  // ─── Routes ─────────────────────────────────────────────────────────────────

  const handleMcpRequest = createMcpRequestHandler(sql, app.log as unknown as import("pino").BaseLogger);

  /** POST /mcp — Main MCP Streamable HTTP endpoint. */
  app.post("/mcp", async (request, reply) => {
    await handleMcpRequest(request, reply);
  });

  /** GET /mcp — SSE stream for server-initiated messages (MCP Streamable HTTP spec). */
  app.get("/mcp", async (request, reply) => {
    await handleMcpRequest(request, reply);
  });

  /** DELETE /mcp — Session termination (MCP Streamable HTTP spec). */
  app.delete("/mcp", async (request, reply) => {
    await handleMcpRequest(request, reply);
  });

  /** GET /health — Health check. */
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  /**
   * GET /.well-known/oauth-authorization-server — RFC 8414 Authorization Server Metadata.
   *
   * Tells MCP clients where to find the authorization, token, and other OAuth
   * endpoints for this server. Clients discover this URL via the `authorization_servers`
   * array in the protected resource metadata (Issue 1 / RFC 9728).
   */
  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["gmail:read", "gmail:modify"],
  }));

  /**
   * GET /.well-known/oauth-protected-resource — RFC 9728 Protected Resource Metadata.
   *
   * The canonical resource is the server root (config.baseUrl), NOT /mcp.
   * RFC 9728 §4 constructs the well-known URL by inserting
   * "/.well-known/oauth-protected-resource" before the resource path, so:
   *   resource = https://example.com        → /.well-known/oauth-protected-resource
   *   resource = https://example.com/mcp   → /.well-known/oauth-protected-resource/mcp
   * Advertising /mcp as the resource while serving metadata at the root well-known
   * URL is inconsistent and may fail strict clients.
   *
   * NOTE: authorization_servers points to this same origin. Clients that follow
   * that URL to the next discovery step (RFC 8414 /.well-known/oauth-authorization-server)
   * will currently receive a 404 until Issue 2 is implemented.
   */
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: config.baseUrl,
    authorization_servers: [config.baseUrl],
    scopes_supported: ["gmail:read", "gmail:modify"],
    bearer_methods_supported: ["header"],
  }));

  await registerOAuthRoutes(app);

  return app;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

/** Starts the server. Only called when this file is the main entrypoint. */
async function main(): Promise<void> {
  // Run pending migrations before accepting requests.
  await runMigrations(sql);

  const app = await buildApp();

  const address = await app.listen({
    port: config.port,
    host: "0.0.0.0",
  });

  app.log.info({ address }, "Gmail Organizer MCP server started");

  // ─── Graceful shutdown ──────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    app.log.info({ signal }, "Shutdown signal received");
    await app.close();
    await closeDb();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only run the server when executed directly (not imported in tests).
// ESM main module detection: compare the resolved file URL to process.argv[1].
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
