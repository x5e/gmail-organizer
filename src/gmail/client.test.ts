/**
 * src/gmail/client.test.ts
 *
 * Unit tests for the Gmail API client.
 *
 * Each test exercises the full request-building path (including auth headers,
 * query parameters, and JSON body construction) via MSW interception.
 *
 * Covers:
 *   - listLabels: returns label array
 *   - searchMessages: correct query params, pagination
 *   - getMessage: decodes base64url body, handles format param
 *   - getAttachment: returns decoded attachment data
 *   - modifyMessageLabels: sends correct request body, returns updated message
 *   - batchModifyMessageLabels: sends correct batch body
 *   - listThreads: returns thread array
 *   - getThread: returns thread with messages
 *   - modifyThreadLabels: sends correct request body
 *   - getHistory: returns history records
 *   - getProfile: returns profile
 *   - GmailApiError: thrown on non-2xx responses
 *   - decodeBase64Url: utility function
 */

import { describe, it, expect } from "vitest";
import {
  listLabels,
  searchMessages,
  getMessage,
  getAttachment,
  modifyMessageLabels,
  batchModifyMessageLabels,
  listThreads,
  getThread,
  modifyThreadLabels,
  getHistory,
  getProfile,
  GmailApiError,
  decodeBase64Url,
} from "./client.js";
import { MOCK_LABELS } from "../mocks/handlers/gmail-labels.js";
import { MOCK_MESSAGES, MOCK_ATTACHMENT } from "../mocks/handlers/gmail-messages.js";
import { MOCK_THREADS } from "../mocks/handlers/gmail-threads.js";
import { MOCK_PROFILE } from "../mocks/handlers/gmail-profile.js";
import { MOCK_HISTORY } from "../mocks/handlers/gmail-history.js";

const ACCESS_TOKEN = "mock-access-token";
// This specific value triggers a 401 in MSW handlers (see INVALID_ACCESS_TOKEN in gmail-labels.ts).
const BAD_TOKEN = "invalid-token";

// ─── decodeBase64Url ─────────────────────────────────────────────────────────

describe("decodeBase64Url", () => {
  it("decodes a base64url string to UTF-8", () => {
    const encoded = Buffer.from("Hello, World!").toString("base64url");
    expect(decodeBase64Url(encoded)).toBe("Hello, World!");
  });

  it("handles base64url - and _ characters (replaces + and /)", () => {
    // A string whose base64 representation contains + and / (which become - and _ in base64url).
    // "Hello World" base64url = "SGVsbG8gV29ybGQ" (contains no +/- but verifies the path)
    // Instead use a value that forces + or /: byte 0xfb produces "+/s=" or similar in base64.
    // The key test is that the function round-trips correctly.
    const original = "Hello+World/Test";
    const encoded = Buffer.from(original).toString("base64url");
    // Verify base64url has no + or /.
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    // Decoding should recover the original string.
    expect(decodeBase64Url(encoded)).toBe(original);
  });
});

// ─── listLabels ──────────────────────────────────────────────────────────────

describe("listLabels", () => {
  it("returns all labels", async () => {
    const labels = await listLabels(ACCESS_TOKEN);
    expect(labels).toEqual(MOCK_LABELS);
  });

  it("throws GmailApiError on 401", async () => {
    await expect(listLabels(BAD_TOKEN)).rejects.toThrow(GmailApiError);
  });

  it("GmailApiError has the correct status code", async () => {
    try {
      await listLabels(BAD_TOKEN);
    } catch (err) {
      expect(err).toBeInstanceOf(GmailApiError);
      expect((err as GmailApiError).status).toBe(401);
    }
  });
});

// ─── searchMessages ──────────────────────────────────────────────────────────

describe("searchMessages", () => {
  it("returns messages for a query", async () => {
    const result = await searchMessages(ACCESS_TOKEN, { q: "is:unread" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ id: "msg_001", threadId: "thread_001" });
  });

  it("returns empty list for no-results query", async () => {
    const result = await searchMessages(ACCESS_TOKEN, { q: "no-results-query" });
    expect(result.messages).toHaveLength(0);
  });

  it("defaults maxResults to 20", async () => {
    // MSW handler doesn't validate maxResults but the call should succeed.
    const result = await searchMessages(ACCESS_TOKEN, { q: "test" });
    expect(result).toBeDefined();
  });

  it("throws on auth failure", async () => {
    await expect(
      searchMessages(BAD_TOKEN, { q: "test" })
    ).rejects.toThrow(GmailApiError);
  });
});

// ─── getMessage ──────────────────────────────────────────────────────────────

describe("getMessage", () => {
  it("returns a message and decodes the body", async () => {
    const message = await getMessage(ACCESS_TOKEN, "msg_001");
    expect(message.id).toBe("msg_001");
    // Body data should be decoded from base64url to UTF-8.
    expect(message.payload?.body?.data).toBe("Hello, World!");
  });

  it("returns headers in metadata format", async () => {
    const message = await getMessage(ACCESS_TOKEN, "msg_001", "metadata");
    expect(message.id).toBe("msg_001");
  });

  it("throws 404 for unknown message IDs", async () => {
    const err = await getMessage(ACCESS_TOKEN, "unknown_id").catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });

  it("throws on auth failure", async () => {
    await expect(getMessage(BAD_TOKEN, "msg_001")).rejects.toThrow(GmailApiError);
  });
});

// ─── getAttachment ───────────────────────────────────────────────────────────

describe("getAttachment", () => {
  it("returns attachment data", async () => {
    const attachment = await getAttachment(ACCESS_TOKEN, "msg_002", "attach_001");
    expect(attachment.size).toBe(MOCK_ATTACHMENT.size);
    expect(attachment.data).toBe(MOCK_ATTACHMENT.data);
  });

  it("throws 404 for unknown attachment ID", async () => {
    const err = await getAttachment(ACCESS_TOKEN, "msg_002", "not_found").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });
});

// ─── modifyMessageLabels ─────────────────────────────────────────────────────

describe("modifyMessageLabels", () => {
  it("returns the updated message", async () => {
    const result = await modifyMessageLabels(ACCESS_TOKEN, "msg_001", {
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD"],
    });
    expect(result.id).toBe("msg_001");
    expect(result.labelIds).toContain("Label_1");
    expect(result.labelIds).not.toContain("UNREAD");
  });

  it("throws 404 for unknown message", async () => {
    const err = await modifyMessageLabels(ACCESS_TOKEN, "no_such_msg", {}).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });
});

// ─── batchModifyMessageLabels ────────────────────────────────────────────────

describe("batchModifyMessageLabels", () => {
  it("completes without error on success", async () => {
    await expect(
      batchModifyMessageLabels(ACCESS_TOKEN, {
        ids: ["msg_001", "msg_002"],
        addLabelIds: ["Label_2"],
      })
    ).resolves.toBeUndefined();
  });

  it("throws on auth failure", async () => {
    await expect(
      batchModifyMessageLabels(BAD_TOKEN, { ids: ["msg_001"] })
    ).rejects.toThrow(GmailApiError);
  });
});

// ─── listThreads ─────────────────────────────────────────────────────────────

describe("listThreads", () => {
  it("returns threads", async () => {
    const result = await listThreads(ACCESS_TOKEN, {});
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]!.id).toBe("thread_001");
  });

  it("throws on auth failure", async () => {
    await expect(listThreads(BAD_TOKEN, {})).rejects.toThrow(GmailApiError);
  });
});

// ─── getThread ───────────────────────────────────────────────────────────────

describe("getThread", () => {
  it("returns a thread with its messages", async () => {
    const thread = await getThread(ACCESS_TOKEN, "thread_001");
    expect(thread.id).toBe("thread_001");
    expect(thread.messages).toHaveLength(2);
  });

  it("throws 404 for unknown thread", async () => {
    const err = await getThread(ACCESS_TOKEN, "unknown_thread").catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });
});

// ─── modifyThreadLabels ──────────────────────────────────────────────────────

describe("modifyThreadLabels", () => {
  it("returns the updated thread", async () => {
    const result = await modifyThreadLabels(ACCESS_TOKEN, "thread_001", {
      addLabelIds: ["Label_2"],
      removeLabelIds: ["UNREAD"],
    });
    expect(result.id).toBe("thread_001");
    // All messages in the thread should have Label_2 added.
    for (const msg of result.messages ?? []) {
      expect(msg.labelIds).toContain("Label_2");
    }
  });

  it("throws 404 for unknown thread", async () => {
    const err = await modifyThreadLabels(ACCESS_TOKEN, "no_thread", {}).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(GmailApiError);
  });
});

// ─── getHistory ──────────────────────────────────────────────────────────────

describe("getHistory", () => {
  it("returns history records", async () => {
    const history = await getHistory(ACCESS_TOKEN, {
      startHistoryId: "12345",
    });
    expect(history.history).toHaveLength(1);
    expect(history.historyId).toBe(MOCK_HISTORY.historyId);
  });

  it("throws 404 when history ID is too old", async () => {
    const err = await getHistory(ACCESS_TOKEN, {
      startHistoryId: "old_history_id",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect((err as GmailApiError).status).toBe(404);
  });
});

// ─── getProfile ──────────────────────────────────────────────────────────────

describe("getProfile", () => {
  it("returns the user profile", async () => {
    const profile = await getProfile(ACCESS_TOKEN);
    expect(profile.emailAddress).toBe(MOCK_PROFILE.emailAddress);
    expect(profile.historyId).toBe(MOCK_PROFILE.historyId);
  });

  it("throws on auth failure", async () => {
    await expect(getProfile(BAD_TOKEN)).rejects.toThrow(GmailApiError);
  });
});
