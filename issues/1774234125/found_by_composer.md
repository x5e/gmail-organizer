# Code review findings (Composer)

This document summarizes a review of the codebase (`src/` and related files) against `docs/OVERVIEW.md`, `docs/TECHNICAL_SPEC.md`, and `docs/TECH_CHOICES.md`. Findings are grouped by severity. Items reference the state of the repository at the time of review.

---

## Security and public-launch posture

### MCP authentication model

The MCP endpoint treats `Authorization: Bearer <token>` as the internal user UUID returned from the OAuth callback (`src/mcp.ts`). There is no cryptographic binding (e.g. signed JWT) proving the caller is Claude or the legitimate client—only HTTPS and secrecy of the UUID protect access. Anyone who obtains that UUID can invoke tools as that connected account. For a public connector, document the threat model, consider alignment with Anthropic’s actual connector auth expectations, and define operational response if a token leaks.

### CORS defaults to permissive behavior

`src/server.ts` uses `origin: process.env["ALLOWED_ORIGIN"] ?? true`. When `ALLOWED_ORIGIN` is unset, this does not match the “strict CORS; `/mcp` should only accept requests from Claude’s infrastructure” intent described in `TECH_CHOICES.md`. Production deployments should set `ALLOWED_ORIGIN` explicitly; it is not documented in `.env.example`, so the permissive default is easy to ship unintentionally.

### Rate limiting applies app-wide

`@fastify/rate-limit` is registered on the entire Fastify instance, so `/oauth/authorize`, `/oauth/callback`, and `/health` share the same limits as `/mcp` (keyed by bearer substring or IP). The tech choices doc emphasizes limiting `/mcp`; OAuth endpoints may be affected under shared-IP or burst scenarios.

### OAuth reconnect creates duplicate users

Each successful token exchange calls `createUser` and stores tokens under a new UUID (`src/oauth/tokens.ts`). Reconnecting the same Google account does not merge on a stable Google subject id, so multiple valid refresh-token rows can exist for one Gmail account. This complicates data lifecycle, “delete my data” operations, and support.

---

## Specification and documentation mismatches

### `get_thread` does not decode message bodies

`TECHNICAL_SPEC.md` requires decoding base64url body data for callers on `get_message`. `getMessage` applies `decodeMessageParts` for `format === "full"`, but `getThread` (`src/gmail/client.ts`) performs a plain GET and never decodes nested `messages[].payload` bodies. Thread responses can still contain raw base64url in body fields, inconsistent with `get_message` and the spec’s readability goal.

### `get_attachment` vs technical spec

The spec asks for decoded content and the attachment’s MIME type (from message part metadata). The tool handler (`src/tools/index.ts`) returns decoded data but omits `mimeType`. Decoding uses `Buffer.toString("utf8")`, which corrupts binary attachments (PDFs, images, etc.). Text-oriented attachments are fine; binary types need base64 (or another explicit representation), not UTF-8 text.

### `get_message` and binary inline parts

`decodeBase64Url` in `src/gmail/client.ts` always interprets decoded bytes as UTF-8. That suits typical `text/plain` and `text/html` parts but is incorrect for inline non-text parts that still expose `body.data`.

### Logging and audit trail (`TECH_CHOICES.md`)

`TECH_CHOICES.md` specifies info-level logging for every tool invocation (user id, tool name, duration, success/failure) and additional logging for write operations (affected ids, label adds/removes). Current code logs OAuth and server lifecycle events but not per-tool or write-audit events in `src/tools/index.ts`. This is a gap versus the documented operational and audit design.

### Overview vs `get_history` behavior

`OVERVIEW.md` mentions mailbox history including deleted messages in broad terms; `TECHNICAL_SPEC.md` restricts `historyTypes` to `labelAdded`, `labelRemoved`, and `messageAdded`, and `getHistory` matches that. The implementation matches the technical spec; the overview is slightly broader—worth aligning wording to avoid user confusion.

---

## Smaller inconsistencies and notes

- **`npm run coverage` vs repo scripts:** `TECH_CHOICES.md` references `npm run coverage`; `package.json` exposes `test:coverage`. Minor contributor friction.
- **Batch modify:** Spec allows either auto-split or error for more than 1,000 ids; Zod `max(1000)` on `ids` enforces rejection—valid per spec.
- **Label safety:** TRASH/SPAM blocking and pre-write label existence checks match the technical spec.

---

## Aspects that align well with the docs

- Streamable HTTP MCP transport in stateless mode (`sessionIdGenerator: undefined` in `src/mcp.ts`).
- Tool hint annotations (`readOnlyHint` / `destructiveHint: false`) on write tools.
- Single `gmail.modify` scope, PKCE OAuth flow, encrypted refresh tokens, proactive access-token refresh.
- PostgreSQL + `postgres` client, parameterized SQL, migration approach per `TECH_CHOICES.md`.
- TypeScript `strict: true` and ES2022 target per tech choices.

---

## Suggested priority for remediation

1. Tighten CORS for production, document `ALLOWED_ORIGIN` in `.env.example`, and treat default `true` as dev-only.
2. Decode thread message bodies consistently with `get_message`; fix attachment and binary body handling (MIME type + safe encoding for non-text).
3. Implement the logging and write-audit behavior already described in `TECH_CHOICES.md`.
4. Document or redesign MCP bearer identity (and optionally deduplicate OAuth connections by Google account id) for public deployment and compliance narratives.
