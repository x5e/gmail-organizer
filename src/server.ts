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
    methods: ["GET", "POST", "OPTIONS"],
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

  const handleMcpRequest = createMcpRequestHandler(sql);

  /** POST /mcp — Main MCP Streamable HTTP endpoint. */
  app.post("/mcp", async (request, reply) => {
    await handleMcpRequest(request, reply);
  });

  /** GET /health — Health check. */
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
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
