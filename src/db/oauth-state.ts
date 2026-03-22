/**
 * src/db/oauth-state.ts
 *
 * Database operations for the `oauth_state` table.
 *
 * OAuth state rows are created at the start of each authorization flow and
 * deleted immediately after the callback completes. They store the PKCE
 * code_verifier and the CSRF `state` parameter.
 *
 * Rows older than 10 minutes are considered stale (the user took too long to
 * complete the OAuth flow). They are cleaned up each time a callback is processed.
 */

import type postgres from "postgres";
import { sql as defaultSql } from "./index.js";

export interface OAuthStateRow {
  state: string;
  codeVerifier: string;
  createdAt: Date;
}

/**
 * Inserts a new OAuth state row at the beginning of an authorization flow.
 */
export async function createOAuthState(
  db: postgres.Sql = defaultSql,
  { state, codeVerifier }: { state: string; codeVerifier: string }
): Promise<void> {
  await db`
    INSERT INTO oauth_state (state, code_verifier) VALUES (${state}, ${codeVerifier})
  `;
}

/**
 * Retrieves and atomically deletes the OAuth state row for the given state value.
 * Also purges any stale rows older than 10 minutes.
 *
 * Returns null if no matching row exists (already consumed or never created).
 * Returns null if the matching row exists but is older than 10 minutes (expired).
 */
export async function consumeOAuthState(
  db: postgres.Sql = defaultSql,
  state: string
): Promise<OAuthStateRow | null> {
  // Purge stale rows (best-effort cleanup).
  await db`
    DELETE FROM oauth_state WHERE created_at < now() - interval '10 minutes'
  `;

  const rows = await db<
    { state: string; code_verifier: string; created_at: Date }[]
  >`
    DELETE FROM oauth_state WHERE state = ${state}
    RETURNING state, code_verifier, created_at
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;

  return {
    state: row.state,
    codeVerifier: row.code_verifier,
    createdAt: row.created_at,
  };
}
