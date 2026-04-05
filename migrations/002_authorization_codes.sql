-- Migration 002: Authorization codes for MCP OAuth flow
--
-- Extends oauth_state with optional MCP client parameters so the authorize
-- handler can store the client's redirect_uri, code_challenge, and state for
-- later use in the callback.
--
-- Creates authorization_codes table for the two-legged server-issued code flow:
--   1. /oauth/callback issues a short-lived server code and stores it here.
--   2. POST /oauth/token consumes it, validates PKCE, and exchanges with Google.

ALTER TABLE oauth_state
  ADD COLUMN IF NOT EXISTS mcp_redirect_uri TEXT,
  ADD COLUMN IF NOT EXISTS mcp_code_challenge TEXT,
  ADD COLUMN IF NOT EXISTS mcp_client_state TEXT;

CREATE TABLE IF NOT EXISTS authorization_codes (
  code                 TEXT        PRIMARY KEY,
  google_code          TEXT        NOT NULL,
  google_code_verifier TEXT        NOT NULL,
  redirect_uri         TEXT        NOT NULL,
  code_challenge       TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
