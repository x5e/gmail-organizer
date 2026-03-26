/**
 * src/tools/audit-log.test.ts
 *
 * Unit tests for the withAuditLog wrapper that provides structured audit
 * logging for all MCP tool invocations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseLogger } from "pino";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withAuditLog } from "./index.js";
import { GmailApiError } from "../gmail/client.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as BaseLogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const SUCCESS_RESULT: CallToolResult = {
  content: [{ type: "text", text: "ok" }],
};

describe("withAuditLog", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("logs successful tool invocation at info level", async () => {
    const handler = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const wrapped = withAuditLog("list_labels", logger, () => "user-123", handler);

    const result = await wrapped({});

    expect(result).toBe(SUCCESS_RESULT);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "list_labels",
        userId: "user-123",
        success: true,
        durationMs: expect.any(Number),
      }),
      "tool invocation"
    );
  });

  it("measures duration (durationMs >= 0)", async () => {
    const handler = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(SUCCESS_RESULT), 10))
    );
    const wrapped = withAuditLog("list_labels", logger, () => "user-1", handler);

    await wrapped({});

    const payload = logger.info.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes write details for mutation tools", async () => {
    const handler = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const wrapped = withAuditLog(
      "modify_message_labels",
      logger,
      () => "user-123",
      handler,
      (args: { messageId: string; addLabelIds: string[] }) => ({
        messageIds: [args.messageId],
        addLabelIds: args.addLabelIds,
      })
    );

    await wrapped({ messageId: "msg_1", addLabelIds: ["INBOX", "IMPORTANT"] });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "modify_message_labels",
        userId: "user-123",
        success: true,
        messageIds: ["msg_1"],
        addLabelIds: ["INBOX", "IMPORTANT"],
      }),
      "tool invocation"
    );
  });

  it("logs GmailApiError 4xx at warn level", async () => {
    const error = new GmailApiError(404, "Not found");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAuditLog("get_message", logger, () => "user-123", handler);

    await expect(wrapped({})).rejects.toThrow(error);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "get_message",
        userId: "user-123",
        success: false,
        errorStatus: 404,
        errorMessage: "Gmail API error 404: Not found",
        durationMs: expect.any(Number),
      }),
      "tool invocation failed"
    );
  });

  it("logs GmailApiError 5xx at error level", async () => {
    const error = new GmailApiError(500, "Internal server error");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAuditLog("list_labels", logger, () => "user-123", handler);

    await expect(wrapped({})).rejects.toThrow(error);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "list_labels",
        userId: "user-123",
        success: false,
        errorStatus: 500,
        errorMessage: "Gmail API error 500: Internal server error",
      }),
      "tool invocation failed"
    );
  });

  it("logs non-Gmail errors at error level", async () => {
    const error = new Error("unexpected failure");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAuditLog("list_labels", logger, () => "user-123", handler);

    await expect(wrapped({})).rejects.toThrow(error);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "list_labels",
        userId: "user-123",
        success: false,
        errorMessage: "unexpected failure",
      }),
      "tool invocation failed"
    );
    // Should NOT have errorStatus for non-Gmail errors
    const payload = logger.error.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("errorStatus");
  });

  it("re-throws the original error after logging", async () => {
    const error = new GmailApiError(429, "Rate limited");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAuditLog("search_messages", logger, () => "user-1", handler);

    const thrown = await wrapped({}).catch((e: unknown) => e);
    expect(thrown).toBe(error);
  });

  it("does not include write details on failure for write tools", async () => {
    const error = new GmailApiError(403, "Forbidden");
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAuditLog(
      "modify_message_labels",
      logger,
      () => "user-123",
      handler,
      (args: { messageId: string }) => ({ messageIds: [args.messageId] })
    );

    await expect(wrapped({ messageId: "msg_1" })).rejects.toThrow(error);

    // Failure logs should not contain write details (the operation didn't succeed)
    const payload = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("messageIds");
  });

  it("logs batch_modify write details with multiple message IDs", async () => {
    const handler = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const wrapped = withAuditLog(
      "batch_modify_message_labels",
      logger,
      () => "user-456",
      handler,
      (args: { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] }) => ({
        messageIds: args.ids,
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      })
    );

    await wrapped({
      ids: ["msg_1", "msg_2", "msg_3"],
      addLabelIds: ["Label_1"],
      removeLabelIds: ["INBOX"],
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "batch_modify_message_labels",
        userId: "user-456",
        success: true,
        messageIds: ["msg_1", "msg_2", "msg_3"],
        addLabelIds: ["Label_1"],
        removeLabelIds: ["INBOX"],
      }),
      "tool invocation"
    );
  });

  it("logs thread write details for modify_thread_labels", async () => {
    const handler = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const wrapped = withAuditLog(
      "modify_thread_labels",
      logger,
      () => "user-789",
      handler,
      (args: { threadId: string; addLabelIds: string[] }) => ({
        threadId: args.threadId,
        addLabelIds: args.addLabelIds,
      })
    );

    await wrapped({ threadId: "thread_42", addLabelIds: ["IMPORTANT"] });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "modify_thread_labels",
        threadId: "thread_42",
        addLabelIds: ["IMPORTANT"],
      }),
      "tool invocation"
    );
  });
});
