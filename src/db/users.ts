/**
 * src/db/users.ts
 *
 * Database operations for the `users`, `oauth_tokens`, and `bearer_tokens` tables.
 *
 * All token values are handled in plaintext here — encryption and decryption
 * happen in the callers (src/oauth/tokens.ts) before values reach these functions.
 *
 * Note on bytea: postgres.js v3 automatically serializes Buffer instances as
 * hex-escaped bytea (e.g. `\\x...`). No explicit type casting is required.
 */

import type postgres from "postgres";
import { sql as defaultSql } from "./index.js";

export interface OAuthTokenRow {
  userId: string;
  encryptedRefreshToken: Buffer;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  updatedAt: Date;
}

/**
 * Finds an existing user by email or creates a new one.
 * Uses ON CONFLICT to handle the race-free find-or-create pattern.
 */
export async function findOrCreateUserByEmail(
  db: postgres.Sql = defaultSql,
  email: string
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO users (email) VALUES (${email})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id
  `;
  return row!.id;
}

/**
 * Inserts a hashed bearer token into the append-only bearer_tokens table.
 */
export async function insertBearerToken(
  db: postgres.Sql = defaultSql,
  { tokenHash, userId }: { tokenHash: string; userId: string }
): Promise<void> {
  await db`
    INSERT INTO bearer_tokens (token_hash, user_id)
    VALUES (${tokenHash}, ${userId})
  `;
}

/**
 * Resolves a hashed bearer token to a user ID.
 * Returns null if the token does not exist or has been revoked.
 */
export async function resolveToken(
  db: postgres.Sql = defaultSql,
  tokenHash: string
): Promise<string | null> {
  const rows = await db<{ user_id: string }[]>`
    SELECT bt.user_id
    FROM bearer_tokens bt
    LEFT JOIN token_revocations tr ON bt.token_hash = tr.token_hash
    WHERE bt.token_hash = ${tokenHash}
      AND tr.token_hash IS NULL
  `;
  return rows.length > 0 ? rows[0]!.user_id : null;
}

/**
 * Upserts the OAuth token row for a user, replacing any existing values.
 * Called after a successful token exchange or token refresh.
 *
 * postgres.js automatically serializes Buffer → bytea, so encryptedRefreshToken
 * is passed directly without any explicit type wrapper.
 */
export async function upsertOAuthTokens(
  db: postgres.Sql = defaultSql,
  {
    userId,
    encryptedRefreshToken,
    accessToken,
    accessTokenExpiresAt,
  }: {
    userId: string;
    encryptedRefreshToken: Buffer;
    accessToken: string;
    accessTokenExpiresAt: Date;
  }
): Promise<void> {
  await db`
    INSERT INTO oauth_tokens
      (user_id, encrypted_refresh_token, access_token, access_token_expires_at, updated_at)
    VALUES
      (${userId}, ${encryptedRefreshToken}, ${accessToken}, ${accessTokenExpiresAt}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      access_token = EXCLUDED.access_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      updated_at = now()
  `;
}

/**
 * Updates only the access token fields (used during proactive token refresh).
 * Leaves the encrypted_refresh_token unchanged.
 */
export async function updateAccessToken(
  db: postgres.Sql = defaultSql,
  {
    userId,
    accessToken,
    accessTokenExpiresAt,
  }: {
    userId: string;
    accessToken: string;
    accessTokenExpiresAt: Date;
  }
): Promise<void> {
  await db`
    UPDATE oauth_tokens
    SET
      access_token = ${accessToken},
      access_token_expires_at = ${accessTokenExpiresAt},
      updated_at = now()
    WHERE user_id = ${userId}
  `;
}

/**
 * Retrieves the OAuth token row for a user.
 * Returns null if no token row exists (user has not yet completed OAuth).
 *
 * The encrypted_refresh_token is returned as a Buffer (postgres.js parses
 * bytea columns as Buffer by default).
 */
export async function getOAuthTokens(
  db: postgres.Sql = defaultSql,
  userId: string
): Promise<OAuthTokenRow | null> {
  const rows = await db<
    {
      user_id: string;
      encrypted_refresh_token: Buffer;
      access_token: string | null;
      access_token_expires_at: Date | null;
      updated_at: Date;
    }[]
  >`
    SELECT user_id, encrypted_refresh_token, access_token, access_token_expires_at, updated_at
    FROM oauth_tokens
    WHERE user_id = ${userId}
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;

  return {
    userId: row.user_id,
    encryptedRefreshToken: row.encrypted_refresh_token,
    accessToken: row.access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    updatedAt: row.updated_at,
  };
}
