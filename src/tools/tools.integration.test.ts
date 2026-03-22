/**
 * src/tools/tools.integration.test.ts
 *
 * Integration tests for all 11 MCP tool handlers via the POST /mcp endpoint.
 *
 * Each test:
 *   1. Creates a test user with valid OAuth tokens.
 *   2. Sends a POST /mcp request with the user ID as a Bearer token.
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
  userId: string,
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
      Authorization: `Bearer ${userId}`,
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
  userId: string,
  toolName: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: unknown; error?: unknown; [key: string]: unknown }> {
  return sendMcpRequest(userId, "tools/call", { name: toolName, arguments: params });
}

describe("POST /mcp authorization", () => {
  it("returns 401 when Authorization header is missing", async () => {
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
  });

  it("returns 401 when Authorization header has wrong format", async () => {
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
  });
});

describe("tools/list", () => {
  it("returns all 11 tools", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await sendMcpRequest(userId, "tools/list", {});
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
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "list_labels");
    expect(body.result?.content?.[0]?.text).toContain("INBOX");
  });

  it("errors for invalid user ID (no token row)", async () => {
    const body = await callTool("00000000-0000-0000-0000-000000000000", "list_labels");
    expect(body.result?.isError).toBe(true);
  });
});

describe("search_messages tool", () => {
  it("returns messages for a query", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "search_messages", { q: "is:unread" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("msg_001");
  });

  it("validates maxResults bounds", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "search_messages", {
      q: "test",
      maxResults: 9999, // exceeds max of 500
    });
    expect(body.result?.isError).toBe(true);
  });
});

describe("list_threads tool", () => {
  it("returns threads", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "list_threads");
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("thread_001");
  });
});

describe("get_message tool", () => {
  it("returns a message with decoded body", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_message", { messageId: "msg_001" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("Hello, World!");
    expect(text).toContain("msg_001");
  });

  it("returns error for unknown message ID", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_message", { messageId: "unknown_id" });
    expect(body.result?.isError).toBe(true);
  });
});

describe("get_attachment tool", () => {
  it("returns attachment content", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_attachment", {
      messageId: "msg_002",
      attachmentId: "attach_001",
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("PDF content here");
  });
});

describe("get_thread tool", () => {
  it("returns a thread with messages", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_thread", { threadId: "thread_001" });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("thread_001");
    expect(text).toContain("msg_001");
  });

  it("returns error for unknown thread ID", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_thread", { threadId: "unknown_thread" });
    expect(body.result?.isError).toBe(true);
  });
});

describe("get_history tool", () => {
  it("returns history records", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_history", {
      startHistoryId: "12345",
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("12350");
  });
});

describe("get_profile tool", () => {
  it("returns the user profile", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "get_profile");
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("testuser@example.com");
  });
});

describe("modify_message_labels tool", () => {
  it("modifies labels on a message", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("msg_001");
  });

  it("blocks TRASH label", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("TRASH");
  });

  it("blocks SPAM label in removeLabelIds", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_message_labels", {
      messageId: "msg_001",
      removeLabelIds: ["SPAM"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects unknown label IDs", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_message_labels", {
      messageId: "msg_001",
      addLabelIds: ["NONEXISTENT_LABEL_XYZ"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("Unknown label ID");
  });
});

describe("modify_thread_labels tool", () => {
  it("modifies labels on a thread", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["Label_2"],
      removeLabelIds: ["UNREAD"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("thread_001");
  });

  it("blocks TRASH label", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects unknown label IDs", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_thread_labels", {
      threadId: "thread_001",
      addLabelIds: ["FAKE_LABEL"],
    });
    expect(body.result?.isError).toBe(true);
  });
});

describe("error handling in write tools", () => {
  it("modify_thread_labels returns error for unknown thread", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "modify_thread_labels", {
      threadId: "no_such_thread",
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/not found/i);
  });

  it("tools return 401 error message when access token is rejected by Gmail API", async () => {
    // Store "invalid-token" as the access token — MSW rejects it with 401.
    const { userId } = await createTestUserWithTokens(db, {
      accessToken: "invalid-token",
      // Expiry well in future so no refresh attempt is made
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const body = await callTool(userId, "list_labels");
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/authorization/i);
  });
});

describe("batch_modify_message_labels tool", () => {
  it("batch-modifies labels on multiple messages", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "batch_modify_message_labels", {
      ids: ["msg_001", "msg_002"],
      addLabelIds: ["Label_2"],
    });
    const text = body.result?.content?.[0]?.text;
    expect(text).toContain("success");
    expect(text).toContain("2");
  });

  it("blocks TRASH label in batch operations", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "batch_modify_message_labels", {
      ids: ["msg_001"],
      addLabelIds: ["TRASH"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects empty ids array", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "batch_modify_message_labels", {
      ids: [],
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
  });

  it("rejects ids array exceeding 1000 messages", async () => {
    const { userId } = await createTestUserWithTokens(db);
    const body = await callTool(userId, "batch_modify_message_labels", {
      ids: Array.from({ length: 1001 }, (_, i) => `msg_${i}`),
      addLabelIds: ["Label_1"],
    });
    expect(body.result?.isError).toBe(true);
  });
});
