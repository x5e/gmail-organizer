/**
 * src/db/oauth-state.test.ts
 *
 * Unit tests for OAuth state table operations.
 *
 * Covers:
 *   - createOAuthState: creates a row
 *   - consumeOAuthState: returns and deletes the row
 *   - consumeOAuthState: returns null for unknown state
 *   - consumeOAuthState: returns null and cleans up stale rows (>10 min)
 *   - PKCE code verifier round-trip
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createOAuthState, consumeOAuthState } from "./oauth-state.js";
import { createTestDb, truncateAllTables } from "../test/db-helpers.js";

const db = createTestDb();

beforeEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await db.end();
});

describe("createOAuthState / consumeOAuthState", () => {
  it("creates and consumes a state row", async () => {
    await createOAuthState(db, {
      state: "test-state-abc",
      codeVerifier: "test-verifier-xyz",
    });

    const row = await consumeOAuthState(db, "test-state-abc");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("test-state-abc");
    expect(row!.codeVerifier).toBe("test-verifier-xyz");
  });

  it("returns null for unknown state", async () => {
    const row = await consumeOAuthState(db, "nonexistent-state");
    expect(row).toBeNull();
  });

  it("deletes the row after consuming (one-time use)", async () => {
    await createOAuthState(db, { state: "one-time", codeVerifier: "verifier" });
    await consumeOAuthState(db, "one-time");

    // Consuming again must return null.
    const row = await consumeOAuthState(db, "one-time");
    expect(row).toBeNull();
  });

  it("preserves the code verifier round-trip (PKCE)", async () => {
    // Simulate a real PKCE code verifier (base64url, 96 chars).
    const codeVerifier =
      "dGVzdC12ZXJpZmllci1sb25nLXN0cmluZy10aGF0LWlzLWV4YWN0bHk5NmNoYXJz";

    await createOAuthState(db, { state: "pkce-test", codeVerifier });
    const row = await consumeOAuthState(db, "pkce-test");

    expect(row!.codeVerifier).toBe(codeVerifier);
  });

  it("cleans up stale rows on consume", async () => {
    // Insert a row directly with a past created_at to simulate a stale row.
    await db`
      INSERT INTO oauth_state (state, code_verifier, created_at)
      VALUES ('stale-state', 'verifier', now() - interval '15 minutes')
    `;

    // Consuming anything should trigger cleanup.
    await consumeOAuthState(db, "nonexistent");

    // The stale row should be gone.
    const rows = await db`SELECT state FROM oauth_state WHERE state = 'stale-state'`;
    expect(rows).toHaveLength(0);
  });
});
