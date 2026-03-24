/**
 * src/tools/401-retry.integration.test.ts
 *
 * Integration test for the 401 refresh-and-retry path.
 *
 * Scenario: A user has a cached access token that appears valid by its expiry
 * timestamp, but Gmail returns 401 (e.g. the token was revoked or the server
 * rejected it due to clock skew). The connector must force-refresh the token
 * and retry the Gmail call once before surfacing an error.
 *
 * Test setup:
 *   - A real Postgres test DB (shared with other integration tests).
 *   - MSW intercepts Gmail API and Google OAuth HTTP calls.
 *   - The "invalid-token" sentinel triggers 401 in every MSW Gmail handler.
 *   - The MSW OAuth handler issues a fresh token on refresh unless the refresh
 *     token itself is "invalid_refresh_token".
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import { createMcpRequestHandler } from "../mcp.js";
import {
  createTestDb,
  createTestUserWithTokens,
  truncateAllTables,
} from "../test/db-helpers.js";
import { INVALID_ACCESS_TOKEN } from "../mocks/handlers/gmail-labels.js";
import { MOCK_LABELS } from "../mocks/handlers/gmail-labels.js";

const db = createTestDb();

// Minimal Fastify app wired to the test DB (no CORS / rate-limiter overhead).
const app = Fastify({ logger: false });
const handleMcpRequest = createMcpRequestHandler(db);
app.post("/mcp", async (request, reply) => {
  await handleMcpRequest(request, reply);
});

beforeEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses an MCP response body that may arrive as plain JSON or as an SSE
 * stream (the MCP SDK chooses the format based on the Accept header).
 */
function parseMcpBody(body: string): unknown {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  // SSE: find the first "data:" line and parse its payload.
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      return JSON.parse(l.slice(5).trim());
    }
  }
  throw new Error(`Cannot parse MCP response body: ${body}`);
}

/** Sends a tools/call request for the given tool and returns the parsed body. */
async function callTool(
  bearerToken: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
  });

  expect(response.statusCode).toBe(200);
  return parseMcpBody(response.body);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("post-401 token refresh and retry", () => {
  it("retries list_labels after a 401 from Gmail and returns labels on the second attempt", async () => {
    // The user's cached access token is "invalid-token" — still well within its
    // expiry window, so proactive refresh does NOT fire. Gmail returns 401 for it.
    // The connector should force-refresh (using the valid refresh token) and retry.
    const { bearerToken } = await createTestUserWithTokens(db, {
      accessToken: INVALID_ACCESS_TOKEN,          // triggers 401 in MSW Gmail handlers
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000), // 1 hour away — no proactive refresh
      refreshToken: "mock-refresh-token-abc",     // accepted by the MSW OAuth handler
    });

    const parsed = (await callTool(bearerToken, "list_labels")) as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    // No JSON-RPC error.
    expect(parsed.error).toBeUndefined();

    // The result should contain the label list from the MSW mock.
    const content = parsed.result?.content;
    expect(content).toBeDefined();
    expect(content![0]!.type).toBe("text");

    const labels = JSON.parse(content![0]!.text) as unknown[];
    expect(labels).toHaveLength(MOCK_LABELS.length);
  });

  it("surfaces an auth error when the refresh token is also invalid", async () => {
    // Same initial state: "invalid-token" causes a 401 from Gmail.
    // But the refresh token is "invalid_refresh_token" — the MSW OAuth handler
    // returns 400 for it, so the forced refresh also fails.
    const { bearerToken } = await createTestUserWithTokens(db, {
      accessToken: INVALID_ACCESS_TOKEN,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: "invalid_refresh_token",      // MSW OAuth handler returns 400
    });

    const parsed = (await callTool(bearerToken, "list_labels")) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    // The tool should not silently succeed.
    // MCP tool errors surface either as a JSON-RPC error or as isError content.
    const hasError =
      parsed.error !== undefined ||
      parsed.result?.isError === true ||
      (parsed.result?.content?.[0]?.text ?? "").toLowerCase().includes("error");

    expect(hasError).toBe(true);
  });
});
