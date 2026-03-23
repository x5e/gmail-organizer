-- Migration 001: Initial schema
--
-- Creates the core tables needed by the Gmail Organizer MCP connector:
--   users              — one row per connected Google account
--   oauth_tokens       — encrypted refresh token + cached access token per user
--   oauth_state        — short-lived PKCE state rows (created at auth start, deleted after callback)
--   bearer_tokens      — hashed bearer tokens for API authentication (append-only)
--   token_revocations  — records of revoked bearer tokens (append-only)
--
-- Also creates the schema_migrations table used by the migration runner itself.

-- Track applied migrations so the runner can skip already-applied files.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per user who has connected their Gmail account.
-- The email column is the user's Gmail address (obtained via OpenID Connect
-- during OAuth) and serves as the natural key for deduplication.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stores encrypted OAuth credentials per user.
-- encrypted_refresh_token is stored as BYTEA: nonce || ciphertext || auth_tag.
-- access_token is stored in plaintext because it is short-lived (1 hour) and
-- can always be regenerated from the refresh token; it is cached here only to
-- avoid redundant round-trips to Google's token endpoint.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_refresh_token BYTEA NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived rows created at the start of each OAuth flow and deleted after
-- the callback completes. Stores the PKCE code_verifier and CSRF state value.
-- Rows older than 10 minutes are considered stale and are cleaned up on each
-- callback (see oauth/handlers.ts).
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hashed bearer tokens used to authenticate MCP API requests.
-- Only the SHA-256 hash of the token is stored; the plaintext is returned to
-- the client once at OAuth completion and never persisted.
-- This table is append-only: rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS bearer_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Records of manually revoked bearer tokens.
-- This table is append-only: to revoke a token, insert a row here.
CREATE TABLE IF NOT EXISTS token_revocations (
  token_hash TEXT PRIMARY KEY REFERENCES bearer_tokens(token_hash),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
