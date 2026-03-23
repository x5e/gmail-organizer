# Findings from GPT review

This review was based on `docs/OVERVIEW.md`, `docs/TECHNICAL_SPEC.md`, `docs/TECH_CHOICES.md`, and the current implementation under `src/` plus top-level project files. I did not read other issue writeups in this folder.

I also attempted a quick verification pass:
- `npm run lint` did not complete cleanly in this checkout.
- `npm test` did not complete here because the configured test Postgres port (`5433`) was already in use on this machine.

The findings below are therefore primarily from code review, with the most launch-relevant issues listed first.

## Critical

### 1. The server uses the database `userId` itself as the long-lived bearer credential

Relevant files:
- `src/oauth/handlers.ts`
- `src/mcp.ts`
- `src/server.ts`
- `README.md`

What is happening:
- The OAuth callback returns `{ userId }` to the client and explicitly tells the caller to use that value as the bearer token for future MCP requests.
- `POST /mcp` then trusts `Authorization: Bearer <userId>` as the only authentication mechanism and uses it directly to look up Gmail credentials.

Why this is a public-launch blocker:
- A database primary key is being treated as the API secret.
- The token never expires, is not signed, is not scoped, and there is no rotation or revocation path.
- Anyone who obtains that `userId` gets ongoing access to that user's Gmail through this service.
- Reconnects create additional valid identities rather than replacing the old one, which increases the blast radius of any leak.

Why this conflicts with the project goals:
- The docs emphasize strict per-user isolation and secure handling of long-lived credentials.
- Exposing the raw internal user identifier as the credential is a major trust-boundary mistake for an internet-facing service.

Suggested fix:
- Mint a separate high-entropy opaque access token or signed token for connector auth.
- Store only a hash of opaque tokens server-side if possible.
- Add expiry, rotation, and revocation/disconnect support.
- Never expose internal database IDs as bearer credentials.

## High

### 2. CORS is effectively open by default, despite the docs calling for strict origin restrictions

Relevant files:
- `src/server.ts`
- `docs/TECH_CHOICES.md`
- `README.md`

What is happening:
- The Fastify CORS config uses `origin: process.env["ALLOWED_ORIGIN"] ?? true`.
- If `ALLOWED_ORIGIN` is unset, the service accepts requests from any origin.

Why this matters:
- The docs say `/mcp` should only accept requests from Claude's infrastructure.
- Leaving this open by default is the opposite of a secure production default.
- On its own this is already undesirable; combined with the weak bearer-token design above, it makes token abuse easier if a token is ever exposed in a browser context.

Suggested fix:
- Fail startup in production if an explicit allowed origin is not configured.
- Use a narrow allowlist, not a permissive fallback.
- Document the required setting in `.env.example`, not just in the README.

### 3. `get_attachment` is text-only and will corrupt or mishandle binary attachments

Relevant files:
- `src/tools/index.ts`
- `src/gmail/client.ts`
- `docs/TECHNICAL_SPEC.md`

What is happening:
- Attachment data is base64url-decoded and then blindly converted with `toString("utf8")`.
- The tool response does not include MIME type.

Why this matters:
- Many real Gmail attachments are binary (`pdf`, `docx`, images, spreadsheets).
- Converting arbitrary binary bytes to UTF-8 text produces unusable or misleading output.
- The technical spec explicitly says the tool should surface decoded content and MIME type in a usable form, and should be careful about large attachments.

Suggested fix:
- Return MIME type alongside the payload.
- Only decode to UTF-8 text for text-like MIME types.
- For binary content, return base64 plus metadata, or a safe summary/extraction path rather than pretending the bytes are text.

## Medium

### 4. `get_thread` does not do the message-body decoding that `get_message` does

Relevant files:
- `src/gmail/client.ts`
- `src/tools/index.ts`
- `docs/TECHNICAL_SPEC.md`

What is happening:
- `getMessage()` recursively decodes MIME body parts.
- `getThread()` just returns the Gmail API response as-is.

Why this matters:
- The spec says `get_thread` should retrieve the full content of a thread.
- In practice, thread messages can contain the same base64url-encoded MIME body data that `get_message` already knows how to decode.
- This means the thread-reading path is less usable than the single-message path and is likely to surface raw encoded content or incomplete results.

Suggested fix:
- Apply the same recursive payload decoding to every message returned by `getThread()`.
- Add tests with thread fixtures that actually include message payload/body data so this cannot regress silently.

### 5. The documented audit logging is not actually implemented

Relevant files:
- `src/server.ts`
- `src/oauth/handlers.ts`
- `src/tools/index.ts`
- `docs/TECH_CHOICES.md`

What is happening:
- The docs say all tool invocations should log user ID, tool name, duration, success/failure, and write-operation details.
- In the current code, logging is limited to startup/shutdown and a few OAuth callback events.
- Tool handlers do not emit the documented audit events.

Why this matters:
- For a public connector that can modify inbox state, auditability is important for debugging, abuse investigation, and compliance review.
- This is also a doc/code mismatch in an area that reviewers are likely to care about.

Suggested fix:
- Add a centralized wrapper around tool execution that logs:
  - user ID
  - tool name
  - duration
  - success/failure
  - write targets and label IDs for mutation tools
- Keep token values redacted as already intended.

### 6. There is no post-401 refresh-and-retry path even though the docs say there is

Relevant files:
- `src/oauth/tokens.ts`
- `src/tools/index.ts`
- `docs/TECH_CHOICES.md`
- `README.md`

What is happening:
- The implementation does proactive refresh before expiry.
- But if Gmail returns `401` for a cached token anyway, the request is surfaced as an auth error and the user is told they may need to re-authenticate.
- There is no forced refresh + single retry path.

Why this matters:
- Access tokens can become invalid before the local expiry timestamp due to revocation, clock skew, or unexpected auth state changes.
- This creates avoidable user-facing failures.
- The README and technical choices doc both imply post-401 retry behavior and test coverage, but the code does not implement it.

Suggested fix:
- On a Gmail `401`, do one forced token refresh and retry the Gmail call once before failing.
- Add an integration test for that exact flow.
