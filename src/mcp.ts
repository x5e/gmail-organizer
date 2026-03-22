/**
 * src/mcp.ts
 *
 * Builds and returns the configured MCP server instance.
 *
 * The server uses the Streamable HTTP transport in stateless mode
 * (sessionIdGenerator: undefined). Each POST to /mcp is self-contained:
 * the bearer token (user ID) is extracted from the Authorization header,
 * the corresponding Gmail tokens are fetched from the database, and the
 * requested Gmail API call is made.
 *
 * Stateless mode means no per-session in-memory state is kept, which allows
 * horizontal scaling without sticky sessions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import type postgres from "postgres";
import { registerTools } from "./tools/index.js";

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
   * Extracts the user ID from the Authorization bearer token, creates a
   * stateless transport + server, registers all tools, and processes the request.
   */
  return async function handleMcpRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Extract user ID from the Authorization: Bearer <userId> header.
    const authHeader = request.headers.authorization ?? "";
    const userId = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (!userId) {
      return reply.status(401).send({
        error: "unauthorized",
        message:
          "Missing or invalid Authorization header. " +
          "Include your user ID as a Bearer token: Authorization: Bearer <userId>",
      });
    }

    // Create a stateless transport + server pair for this request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const server = new McpServer(SERVER_INFO, {
      capabilities: SERVER_CAPABILITIES,
    });

    // Register all tools, closing over the userId for this request.
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
