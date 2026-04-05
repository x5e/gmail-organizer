/**
 * src/tools/tools.integration.test.ts
 *
 * Integration tests for all 11 MCP tool handlers via the POST /mcp endpoint.
 *
 * Each test:
 *   1. Creates a test user with valid OAuth tokens and a bearer token.
 *   2. Sends a POST /mcp request with the bearer token.
 *   3. Asserts the response contains the expected tool result.
 *
 * HTTP is intercepted by MSW (Gmail API calls are mocked).
 * Database operations use the real test Postgres container.
 *
 * Also covers:
 *   - 401 for missing/invalid Authorization header
 *   - TRASH/SPAM label blocking in write tools
 *   - Unknown label ID rejection in write tools
 *   - Batch modify size limit enforcement
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { buildApp } from "../server.js";
import { createTestDb, truncateAllTables, createTestUserWithTokens } from "../test/db-helpers.js";
import { hashToken } from "../oauth/tokens.js";
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

/**
 * Sends a JSON-RPC MCP request to POST /mcp and returns the parsed JSON-RPC response.
 *
 * The Streamable HTTP transport may respond with either:
 *   - application/json  → parse directly
 *   - text/event-stream → extract the `data:` line(s) and parse as JSON
 *
 * The MCP SDK requires Accept: application/json, text/event-stream.
 */
async function sendMcpRequest(
  bearerToken: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: unknown; error?: unknown; [key: string]: unknown }> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Mcp-Session-Id": "test-session",
      Authorization: `Bearer ${bearerToken}`,
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    },
  });

  const contentType = response.headers["content-type"] ?? "";

  if (contentType.includes("text/event-stream")) {
    // SSE format: parse "data: {...}" lines
    const lines = response.body.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          // try next line
        }
      }
    }
    throw new Error(`Could not parse SSE response body: ${response.body.slice(0, 200)}`);
  }

  return JSON.parse(response.body);
}

/** Convenience wrapper for tools/call. */
async function callTool(
  bearerToken: string,
  toolName: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: unknown; error?: unknown; [key: string]: unknown }> {
  return sendMcpRequest(bearerToken, "tools/call", { name: toolName, arguments: params });
}

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns RFC 9728 protected resource metadata", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(response.body);
    // resource is the server root, not the /mcp path (see RFC 9728 §4 path-scoping rules)
    expect(body.resource).toMatch(/^https?:\/\//);
    expect(body.resource).not.toMatch(/\/mcp$/);
    expect(body.authorization_servers).toBeInstanceOf(Array);
    expect(body.authorization_servers).toHaveLength(1);
    expect(body.scopes_supported).toEqual(["gmail:read", "gmail:modify"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("CORS", () => {
  it("exposes WWW-Authenticate header on cross-origin 401 responses", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Origin: "https://claude.ai",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(401);
    // access-control-expose-headers must list WWW-Authenticate so that
    // browser-based MCP clients can read it from a cross-origin response.
    const exposed = response.headers["access-control-expose-headers"] ?? "";
    expect(exposed.toLowerCase()).toContain("www-authenticate");
  });
});

describe("GET /mcp — authenticated", () => {
  /**
   * SSE streams never close in app.inject() (no events arrive, stream stays open).
   * Instead we send a GET without the required Accept: text/event-stream header so
   * the transport returns 406 immediately.  This proves three things without hanging:
   *   1. Auth passed (would be 401 otherwise)
   *   2. The route exists and is wired (would be 404 otherwise)
   *   3. The request reached the MCP transport (which enforces the Accept requirement)
   */
  it("auth passes and request reaches MCP transport (transport returns 406 for missing SSE Accept)", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const response = await app.inject({
      method: "GET",
      url: "/mcp",
      // Deliberately omit Accept: text/event-stream — transport rejects with 406
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(response.statusCode).not.toBe(401); // auth passed
    expect(response.statusCode).not.toBe(404); // route exists
    expect(response.statusCode).toBe(406);     // transport enforces SSE Accept requirement
  });
});

describe("DELETE /mcp — authenticated", () => {
  it("returns 200 (not 401 or 404) with a valid token", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const response = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    // Stateless mode: no session to delete, but auth passed → 200
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(404);
    expect(response.statusCode).toBe(200);
  });
});

describe("GET /mcp authorization", () => {
  it("returns 401 (not 404) with WWW-Authenticate when Authorization header is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: { Accept: "text/event-stream" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });

  it("returns 401 (not 404) with WWW-Authenticate for an invalid bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer invalid-token-xyz",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });
});

describe("DELETE /mcp authorization", () => {
  it("returns 401 (not 404) with WWW-Authenticate when Authorization header is missing", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/mcp",
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });

  it("returns 401 (not 404) with WWW-Authenticate for an invalid bearer token", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: { Authorization: "Bearer invalid-token-xyz" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });
});

describe("POST /mcp authorization", () => {
  it("returns 401 with WWW-Authenticate when Authorization header is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });

  it("returns 401 with WWW-Authenticate when Authorization header has wrong format", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Basic sometoken",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });
});

describe("tools/list", () => {
  it("returns all 11 tools", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await sendMcpRequest(bearerToken, "tools/list", {});
    expect(body.result?.tools).toHaveLength(11);
    const toolNames = (body.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name
    );
    expect(toolNames).toContain("list_labels");
    expect(toolNames).toContain("search_messages");
    expect(toolNames).toContain("list_threads");
    expect(toolNames).toContain("get_message");
    expect(toolNames).toContain("get_attachment");
    expect(toolNames).toContain("get_thread");
    expect(toolNames).toContain("get_history");
    expect(toolNames).toContain("get_profile");
    expect(toolNames).toContain("modify_message_labels");
    expect(toolNames).toContain("modify_thread_labels");
    expect(toolNames).toContain("batch_modify_message_labels");
  });
});

describe("list_labels tool", () => {
  it("returns labels from Gmail API", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "list_labels");
    expect(body.result?.content?.[0]?.text).toContain("INBOX");
  });

  it("returns 401 with WWW-Authenticate for invalid bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer invalid-token-that-does-not-exist",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });

  it("returns 401 with WWW-Authenticate for a revoked bearer token", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const tokenHash = hashToken(bearerToken);

    await db`INSERT INTO token_revocations (token_hash) VALUES (${tokenHash})`;

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: `Bearer ${bearerToken}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(
      /^Bearer resource_metadata=".*\/.well-known\/oauth-protected-resource"$/
    );
  });
});

describe("search_messages tool", () => {
  it("returns messages for a query", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "search_messages", { q: "is:unread" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("msg_001");
  });

  it("validates maxResults bounds", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "search_messages", {
      q: "test",
      maxResults: 9999, // exceeds max of 500
    });
    expect(body.result?.isError).toBe(true);
  });
});

describe("list_threads tool", () => {
  it("returns threads", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "list_threads");
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("thread_001");
  });
});

describe("get_message tool", () => {
  it("returns a message with decoded body", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_message", { messageId: "msg_001" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("Hello, World!");
    expect(text).toContain("msg_001");
  });

  it("returns error for unknown message ID", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_message", { messageId: "unknown_id" });
    expect(body.result?.isError).toBe(true);
  });
});

describe("get_attachment tool", () => {
  it("returns binary attachment as base64 with mimeType (not corrupted UTF-8)", async () => {
    // attach_001 is an application/pdf attachment with real PNG magic bytes.
    // Before the fix, the tool would call toString("utf8") on these bytes,
    // producing a replacement char (U+FFFD) and losing the data irreversibly.
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_attachment", {
      messageId: "msg_002",
      attachmentId: "attach_001",
    });
    const text = body.result?.content?.[0]?.text;
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(text);

    // mimeType must be included in the response.
    expect(parsed.mimeType).toBe("application/pdf");

    // data must be a valid base64 string that round-trips to the original bytes.
    const { BINARY_BYTES } = await import("../mocks/handlers/gmail-messages.js");
    expect(Buffer.from(parsed.data, "base64")).toEqual(BINARY_BYTES);

    // Must NOT contain the UTF-8 replacement char produced by blind utf8 decoding.
    expect(parsed.data).not.toContain("\uFFFD");
  });

  it("returns text attachment as decoded UTF-8 with mimeType", async () => {
    // attach_text_001 is a text/plain attachment — should be decoded to a string.
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_attachment", {
      messageId: "msg_004",
      attachmentId: "attach_text_001",
    });
    const text = body.result?.content?.[0]?.text;
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(text);

    expect(parsed.mimeType).toBe("text/plain");
    expect(parsed.data).toBe("Hello attachment!");
  });
});

describe("get_thread tool", () => {
  it("returns a thread with messages", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_thread", { threadId: "thread_001" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("thread_001");
    expect(text).toContain("msg_001");
  });

  it("decodes text message bodies in thread to UTF-8", async () => {
    // thread_001's msg_001 has a text/plain body — must appear as readable text.
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_thread", { threadId: "thread_001" });
    const text = body.result?.content?.[0]?.text;
    expect(body.result?.isError).toBeFalsy();
    expect(text).toContain("Hello, World!");
  });

  it("keeps binary message bodies in thread as base64 (not corrupted UTF-8)", async () => {
    // thread_001's msg_003 has an image/png body with binary bytes.
    // Before the fix, getThread never decoded bodies at all — raw base64url was returned.
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_thread", { threadId: "thread_001" });
    const text = body.result?.content?.[0]?.text;
    expect(body.result?.isError).toBeFalsy();
    const parsed = JSON.parse(text);
    const msg003 = parsed.messages?.find((m: { id: string }) => m.id === "msg_003");
    const data = msg003?.payload?.body?.data;
    expect(data).toBeDefined();
    // Must NOT contain UTF-8 replacement char from blind utf8 decoding.
    expect(data).not.toContain("\uFFFD");
    // Must round-trip back to the original binary bytes.
    const { BINARY_BYTES } = await import("../mocks/handlers/gmail-messages.js");
    expect(Buffer.from(data, "base64")).toEqual(BINARY_BYTES);
  });

  it("returns error for unknown thread ID", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_thread", { threadId: "unknown_thread" });
    expect(body.result?.isError).toBe(true);
  });
});

describe("get_history tool", () => {
  it("returns history records", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_history", {
      startHistoryId: "12345",
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("12350");
  });
});

describe("get_profile tool", () => {
  it("returns the user profile", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "get_profile");
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("testuser@example.com");
  });
});

describe("modify_message_labels tool", () => {
  it("modifies labels on a message", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("msg_001");
  });

  it("blocks TRASH label", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("TRASH");
  });

  it("blocks SPAM label in removeLabelIds", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_message_labels", {
      messageId: "msg_001",
      removeLabelIds: ["SPAM"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects unknown label IDs", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["NONEXISTENT_LABEL_XYZ"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("Unknown label ID");
  });
});

describe("modify_thread_labels tool", () => {
  it("modifies labels on a thread", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["Label_2"],
      removeLabelIds: ["UNREAD"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("thread_001");
  });

  it("blocks TRASH label", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects unknown label IDs", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["FAKE_LABEL"],
    });
    expect(body.result?.isError).toBe(true);
  });
});

describe("error handling in write tools", () => {
  it("modify_thread_labels returns error for unknown thread", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "modify_thread_labels", {
      threadId: "no_such_thread",
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/not found/i);
  });

  it("tools return auth error when both the access token and refresh token are rejected", async () => {
    // Store "invalid-token" as the access token — MSW rejects it with 401.
    // The refresh token is also invalid, so the forced refresh also fails.
    // Only then should an authorization error surface.
    const { bearerToken } = await createTestUserWithTokens(db, {
      accessToken: "invalid-token",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshToken: "invalid_refresh_token", // MSW OAuth handler returns 400
    });
    const body = await callTool(bearerToken, "list_labels");
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/authorization/i);
  });
});

describe("batch_modify_message_labels tool", () => {
  it("batch-modifies labels on multiple messages", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "batch_modify_message_labels", {
      ids: ["msg_001", "msg_002"],
      addLabelIds: ["Label_2"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("2");
  });

  it("blocks TRASH label in batch operations", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "batch_modify_message_labels", {
      ids: ["msg_001"],
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects empty ids array", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "batch_modify_message_labels", {
      ids: [],
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects ids array exceeding 1000 messages", async () => {
    const { bearerToken } = await createTestUserWithTokens(db);
    const body = await callTool(bearerToken, "batch_modify_message_labels", {
      ids: Array.from({ length: 1001 }, (_, i) => `msg_${i}`),
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
  });
});
