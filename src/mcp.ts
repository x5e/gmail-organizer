/**
 * src/mcp.ts
 *
 * Builds and returns the configured MCP server instance.
 *
 * The server uses the Streamable HTTP transport in stateless mode
 * (sessionIdGenerator: undefined). Each POST to /mcp is self-contained:
 * the bearer token is hashed, resolved to a user ID via the database,
 * and the corresponding Gmail tokens are fetched for the API call.
 *
 * Stateless mode means no per-session in-memory state is kept, which allows
 * horizontal scaling without sticky sessions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import type postgres from "postgres";
import { registerTools } from "./tools/index.js";
import { resolveToken } from "./db/users.js";
import { hashToken } from "./oauth/tokens.js";

/** Package metadata surfaced in the MCP server info. */
const SERVER_INFO = {
  name: "gmail-organizer",
  version: "1.0.0",
};

/** MCP server capabilities — tools only (no resources or prompts). */
const SERVER_CAPABILITIES = {
  tools: {},
};

/**
 * Creates a fresh MCP server with all tools registered and returns it along
 * with a function that handles a single MCP HTTP request.
 *
 * A new McpServer + StreamableHTTPServerTransport pair is created per request
 * in stateless mode (as recommended by the MCP SDK for stateless deployments).
 *
 * @param db - The postgres.js connection pool used for token lookups.
 */
export function createMcpRequestHandler(db: postgres.Sql) {
  /**
   * Handles a single POST /mcp request.
   * Hashes the bearer token, resolves it to a user ID via the database,
   * creates a stateless transport + server, registers tools, and processes
   * the request.
   */
  return async function handleMcpRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers.authorization ?? "";
    const rawToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (!rawToken) {
      return reply.status(401).send({
        error: "unauthorized",
        message:
          "Missing or invalid Authorization header. " +
          "Include your bearer token: Authorization: Bearer <token>",
      });
    }

    const tokenHash = hashToken(rawToken);
    const userId = await resolveToken(db, tokenHash);

    if (!userId) {
      return reply.status(401).send({
        error: "unauthorized",
        message:
          "Bearer token is invalid or has been revoked. " +
          "Please re-authenticate via /oauth/authorize.",
      });
    }

    // Create a stateless transport + server pair for this request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const server = new McpServer(SERVER_INFO, {
      capabilities: SERVER_CAPABILITIES,
    });

    registerTools(server, db, () => userId);

    try {
      await server.connect(transport);

      // Convert Fastify request/reply to Node IncomingMessage/ServerResponse
      // as expected by the MCP SDK transport.
      await transport.handleRequest(
        request.raw,
        reply.raw,
        request.body as Record<string, unknown>
      );
    } finally {
      // Ensure the server is always closed to free resources.
      await server.close();
    }
  };
}
