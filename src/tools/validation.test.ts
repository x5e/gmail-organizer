/**
 * src/tools/validation.test.ts
 *
 * Unit tests for label validation utilities.
 *
 * Covers:
 *   - assertNoBlockedLabels: TRASH and SPAM rejection in addLabelIds / removeLabelIds
 *   - assertLabelsExist: rejects unknown label IDs, accepts known ones
 */

import { describe, it, expect } from "vitest";
import { assertNoBlockedLabels, assertLabelsExist } from "./validation.js";

// The mock Gmail labels handler is active via test setup (MSW).

describe("assertNoBlockedLabels", () => {
  it("does not throw for empty arrays", () => {
    expect(() => assertNoBlockedLabels([], [])).not.toThrow();
  });

  it("does not throw for valid label IDs", () => {
    expect(() =>
      assertNoBlockedLabels(["INBOX", "Label_1"], ["UNREAD"])
    ).not.toThrow();
  });

  it("throws when TRASH is in addLabelIds", () => {
    expect(() => assertNoBlockedLabels(["TRASH"], [])).toThrow(/TRASH/);
  });

  it("throws when SPAM is in addLabelIds", () => {
    expect(() => assertNoBlockedLabels(["SPAM"], [])).toThrow(/SPAM/);
  });

  it("throws when TRASH is in removeLabelIds", () => {
    expect(() => assertNoBlockedLabels([], ["TRASH"])).toThrow(/TRASH/);
  });

  it("throws when SPAM is in removeLabelIds", () => {
    expect(() => assertNoBlockedLabels([], ["SPAM"])).toThrow(/SPAM/);
  });

  it("throws and includes both blocked IDs in the message when both are present", () => {
    expect(() => assertNoBlockedLabels(["TRASH"], ["SPAM"])).toThrow();
  });

  it("throws for undefined arrays (default behaviour)", () => {
    // Should not throw for undefined (treated as empty arrays).
    expect(() => assertNoBlockedLabels(undefined, undefined)).not.toThrow();
  });
});

describe("assertLabelsExist", () => {
  const ACCESS_TOKEN = "mock-access-token";

  it("does not throw when all label IDs exist", async () => {
    await expect(
      assertLabelsExist(ACCESS_TOKEN, ["INBOX", "Label_1"])
    ).resolves.toBeUndefined();
  });

  it("does not throw for an empty list", async () => {
    await expect(assertLabelsExist(ACCESS_TOKEN, [])).resolves.toBeUndefined();
  });

  it("throws for unknown label IDs", async () => {
    await expect(
      assertLabelsExist(ACCESS_TOKEN, ["NONEXISTENT_LABEL"])
    ).rejects.toThrow(/Unknown label ID/);
  });

  it("throws and mentions all unknown IDs in the error", async () => {
    await expect(
      assertLabelsExist(ACCESS_TOKEN, ["INBOX", "BAD_1", "BAD_2"])
    ).rejects.toThrow(/BAD_1/);
  });

  it("throws when the Gmail API returns 401", async () => {
    // "invalid-token" triggers a 401 in the MSW label handler.
    await expect(
      assertLabelsExist("invalid-token", ["INBOX"])
    ).rejects.toThrow(/Failed to fetch label list/);
  });
});
