/**
 * src/test/db-helpers.ts
 *
 * Test utility functions for database operations.
 *
 * Provides helpers for:
 *   - Creating a test database connection
 *   - Truncating all tables between tests (clean state)
 *   - Creating test fixtures (users, tokens, bearer tokens)
 *
 * Note on bytea: postgres.js v3 automatically serializes Buffer → bytea.
 * No explicit type wrapper is needed.
 */

import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { encrypt } from "../crypto.js";
import { config } from "../config.js";
import { hashToken } from "../oauth/tokens.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://test:test@localhost:5433/gmail_organizer_test";

/** Creates a fresh postgres.js connection for use within a single test file. */
export function createTestDb(): postgres.Sql {
  return postgres(DATABASE_URL, { max: 5 });
}

/**
 * Truncates all data tables (except schema_migrations) in the test database.
 * Call this in beforeEach to ensure test isolation.
 */
export async function truncateAllTables(db: postgres.Sql): Promise<void> {
  await db`TRUNCATE TABLE token_revocations, bearer_tokens, oauth_state, oauth_tokens, users CASCADE`;
}

/**
 * Creates a test user with encrypted OAuth tokens and a valid bearer token.
 * Returns the user ID, the plaintext access token, and the plaintext bearer
 * token (suitable for use in Authorization: Bearer headers).
 */
export async function createTestUserWithTokens(
  db: postgres.Sql,
  options: {
    email?: string;
    accessToken?: string;
    accessTokenExpiresAt?: Date;
    refreshToken?: string;
  } = {}
): Promise<{ userId: string; accessToken: string; bearerToken: string }> {
  const email = options.email ?? `test-${randomBytes(4).toString("hex")}@example.com`;
  const accessToken = options.accessToken ?? "test-access-token";
  const refreshToken = options.refreshToken ?? "test-refresh-token";
  const accessTokenExpiresAt =
    options.accessTokenExpiresAt ??
    new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

  const [userRow] = await db<{ id: string }[]>`
    INSERT INTO users (email) VALUES (${email}) RETURNING id
  `;
  const userId = userRow!.id;

  const encryptedRefreshToken = encrypt(refreshToken, config.tokenEncryptionKey);

  await db`
    INSERT INTO oauth_tokens
      (user_id, encrypted_refresh_token, access_token, access_token_expires_at, updated_at)
    VALUES
      (${userId},
       ${encryptedRefreshToken},
       ${accessToken},
       ${accessTokenExpiresAt},
       now())
  `;

  const bearerToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(bearerToken);
  await db`
    INSERT INTO bearer_tokens (token_hash, user_id) VALUES (${tokenHash}, ${userId})
  `;

  return { userId, accessToken, bearerToken };
}
