/**
 * src/db/authorization-codes.ts
 *
 * Database operations for the `authorization_codes` table.
 *
 * Authorization code rows are created when the OAuth callback receives a code
 * from Google in the MCP flow. They store a short-lived server-issued code
 * that the MCP client redeems at POST /oauth/token.
 *
 * Rows expire after 5 minutes. Expiry is enforced atomically in the consume
 * query — the WHERE clause filters out stale rows, so a not-found result
 * means either the code was invalid or it expired.
 */

import type postgres from "postgres";

export interface AuthorizationCodeRow {
  code: string;
  googleCode: string;
  googleCodeVerifier: string;
  redirectUri: string;
  codeChallenge: string;
  createdAt: Date;
}

/**
 * Inserts a new authorization code row.
 */
export async function createAuthorizationCode(
  db: postgres.Sql,
  {
    code,
    googleCode,
    googleCodeVerifier,
    redirectUri,
    codeChallenge,
  }: {
    code: string;
    googleCode: string;
    googleCodeVerifier: string;
    redirectUri: string;
    codeChallenge: string;
  }
): Promise<void> {
  await db`
    INSERT INTO authorization_codes
      (code, google_code, google_code_verifier, redirect_uri, code_challenge)
    VALUES
      (${code}, ${googleCode}, ${googleCodeVerifier}, ${redirectUri}, ${codeChallenge})
  `;
}

/**
 * Retrieves and atomically deletes the authorization code row for the given
 * code value, enforcing a 5-minute TTL.
 *
 * Returns null if no matching row exists (invalid code) or if the row is
 * older than 5 minutes (expired). Both cases are indistinguishable to callers,
 * which prevents timing attacks that probe whether a code was ever valid.
 */
export async function consumeAuthorizationCode(
  db: postgres.Sql,
  code: string
): Promise<AuthorizationCodeRow | null> {
  const rows = await db<
    {
      code: string;
      google_code: string;
      google_code_verifier: string;
      redirect_uri: string;
      code_challenge: string;
      created_at: Date;
    }[]
  >`
    DELETE FROM authorization_codes
    WHERE code = ${code}
      AND created_at > now() - interval '5 minutes'
    RETURNING code, google_code, google_code_verifier, redirect_uri, code_challenge, created_at
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;

  return {
    code: row.code,
    googleCode: row.google_code,
    googleCodeVerifier: row.google_code_verifier,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    createdAt: row.created_at,
  };
}
