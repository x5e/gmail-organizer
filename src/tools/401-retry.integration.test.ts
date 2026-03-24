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
import {
  INVALID_ACCESS_TOKEN,
  MOCK_LABELS,
} from "../mocks/handlers/gmail-labels.js";

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

/** Creates a test user whose cached access token triggers 401 in MSW. */
function revokedTokenUser(refreshToken = "mock-refresh-token-abc") {
  return createTestUserWithTokens(db, {
    accessToken: INVALID_ACCESS_TOKEN,
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000), // 1 hour — no proactive refresh
    refreshToken,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("post-401 token refresh and retry", () => {
  // ── Read-only tool path ───────────────────────────────────────────────────

  it("retries list_labels after a 401 and returns labels on the second attempt", async () => {
    const { bearerToken } = await revokedTokenUser();

    const parsed = (await callTool(bearerToken, "list_labels")) as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    expect(parsed.error).toBeUndefined();

    const content = parsed.result?.content;
    expect(content).toBeDefined();
    expect(content![0]!.type).toBe("text");

    const labels = JSON.parse(content![0]!.text) as unknown[];
    expect(labels).toHaveLength(MOCK_LABELS.length);
  });

  // ── Write tool path (assertLabelsExist hits 401 first) ────────────────────

  it("retries modify_message_labels when assertLabelsExist triggers the 401", async () => {
    // The first Gmail call inside the withGmailRetry closure is assertLabelsExist,
    // which calls listLabels(). With the "invalid-token" access token, that call
    // returns 401 via the GmailApiError that now propagates from assertLabelsExist.
    // withGmailRetry should catch it, force-refresh, and retry the whole closure
    // (assertLabelsExist + modifyMessageLabels) with the fresh token.
    const { bearerToken } = await revokedTokenUser();

    const parsed = (await callTool(bearerToken, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["Label_1"],
    })) as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    expect(parsed.error).toBeUndefined();

    const content = parsed.result?.content;
    expect(content).toBeDefined();
    const body = JSON.parse(content![0]!.text);
    expect(body.success).toBe(true);
  });

  // ── Refresh-token failure path ────────────────────────────────────────────

  it("surfaces a normalized authorization error when the refresh token is also invalid", async () => {
    // Access token → 401 from Gmail, refresh token → 400 from Google OAuth.
    // The error should be wrapped into a GmailApiError(401) by withGmailRetry
    // and then normalized by handleToolError into a clean auth error.
    const { bearerToken } = await revokedTokenUser("invalid_refresh_token");

    const parsed = (await callTool(bearerToken, "list_labels")) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
      error?: unknown;
    };

    expect(parsed.result?.isError).toBe(true);
    expect(parsed.result?.content?.[0]?.text).toMatch(/authorization/i);
    expect(parsed.result?.content?.[0]?.text).toMatch(/re-authenticate/i);
  });
});
