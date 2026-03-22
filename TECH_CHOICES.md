# Gmail Organizer MCP Connector — Technical Choices

This document records the rationale behind every significant implementation decision for the Gmail Organizer MCP connector. It is intended as the authoritative reference for developers working on the project and as a stable record of why things are the way they are.

---

## Language: TypeScript

TypeScript is the primary implementation language. The official MCP SDK (`@modelcontextprotocol/sdk`) has its best and most actively maintained support in TypeScript, its Zod-based tool-definition API gives us runtime input validation for free, and the language's type system catches an entire class of bugs at compile time that would otherwise surface at runtime in a security-sensitive credential-handling service. Node.js with TypeScript is also well-supported across all major hosting platforms.

The TypeScript compiler target should be ES2022 or later, and the project should use `strict: true` in `tsconfig.json`.

---

## MCP SDK: Official `@modelcontextprotocol/sdk`

The official SDK from the MCP team is the only sensible choice for a connector intended for the Anthropic directory. Community frameworks like FastMCP add ergonomics on top of it but introduce an additional dependency whose lifecycle we don't control. The SDK's v1.x series is stable for production; v2 is expected to ship in 2026 and the migration path should be straightforward.

---

## MCP Transport: Streamable HTTP (Stateless)

The server uses the **Streamable HTTP** transport, which is the current standard for remote/hosted MCP servers as of the March 2025 MCP specification update. SSE transport is legacy and must not be used for new implementations.

The server is configured in **stateless mode** by passing `sessionIdGenerator: undefined` when constructing the transport. This means the server maintains no per-session in-memory state — each POST to `/mcp` is fully self-contained. This is the correct model for this connector because every tool call follows the same pattern: extract the user identity from the bearer token, look up the corresponding Gmail credentials from the database, make the Gmail API call, and return the result. There is no streaming or long-running per-user state that would require session continuity.

Stateless mode also means horizontal scaling works without sticky sessions at the load balancer, which simplifies deployment and improves resilience.

---

## HTTP Framework: Fastify

[Fastify](https://fastify.dev) is the HTTP server framework. It is chosen over Express for two reasons: it is significantly faster (relevant under sustained load from multiple connected users), and it has first-class TypeScript support with a strongly-typed plugin and hook system. Fastify is also the native host of Pino (the logger chosen below), so the two work together without any glue code.

Key Fastify plugins in use:

- **`@fastify/rate-limit`** — per-user rate limiting on the `/mcp` endpoint to prevent abuse and protect Google API quota.
- **`@fastify/cors`** — strict CORS policy; the `/mcp` endpoint should only accept requests from Claude's infrastructure.

The server exposes three routes:

| Route | Purpose |
|---|---|
| `POST /mcp` | Main MCP endpoint (Streamable HTTP) |
| `GET /oauth/authorize` | Initiates the OAuth authorization flow |
| `GET /oauth/callback` | Receives the Google OAuth redirect |
| `GET /health` | Health check for load balancers and uptime monitoring |

---

## Database: PostgreSQL (No ORM)

PostgreSQL is used for persistent storage of OAuth refresh tokens and OAuth flow state. No ORM or query builder is used. The database layer is implemented with **[`postgres`](https://github.com/porsager/postgres)** (the `postgres` npm package), which provides:

- A clean tagged-template-literal API that is safe against SQL injection by construction
- Built-in connection pooling
- First-class TypeScript support with inferred result types
- Minimal abstraction — the queries sent to Postgres are plain SQL and are immediately readable

This choice deliberately avoids introducing the abstraction layer of an ORM. The database schema for this project is simple (see below), and keeping the query layer thin means there is no framework to learn, no magic to debug, and no migration tooling to maintain beyond plain SQL files. If the database layer needs to be ported to a different backend in the future, the queries are transparent and portable.

### Schema

Three tables are required:

**`users`** — one row per connected user.
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`oauth_tokens`** — stores the encrypted refresh token and cached access token for each user.
```sql
CREATE TABLE oauth_tokens (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_refresh_token BYTEA NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`oauth_state`** — short-lived rows created at the start of the OAuth flow and deleted after the callback completes. Used to store the PKCE code verifier and the random state parameter between the redirect and the callback.
```sql
CREATE TABLE oauth_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A periodic cleanup job (or a simple `DELETE WHERE created_at < now() - interval '10 minutes'` executed on each callback) keeps the `oauth_state` table from accumulating stale rows.

### Migrations

Migrations are managed with plain SQL files numbered sequentially (e.g., `migrations/001_initial.sql`). A small migration runner script applies any unapplied migrations on startup by tracking which files have been run in a `schema_migrations` table. This keeps the migration system completely transparent with no framework dependency.

---

## Token Encryption: Application-Level AES-256-GCM

OAuth refresh tokens are long-lived credentials granting ongoing access to a user's Gmail account. They must be encrypted at rest.

Encryption and decryption happen entirely within the application, before any data is written to or after any data is read from the database. The database stores only ciphertext and never sees plaintext token values. This is deliberately chosen over database-level encryption (e.g., `pgcrypto`) because it means the plaintext never leaves the application process — a database credential leak alone is not sufficient to recover token values.

**Algorithm:** AES-256-GCM (authenticated encryption — provides both confidentiality and integrity).

**Implementation:** Node's built-in `crypto` module (`crypto.createCipheriv` / `crypto.createDecipheriv`). No third-party cryptography library is required.

**Key management:** The encryption key is a 32-byte random value stored as an environment variable (base64-encoded). It must never be committed to source control. Key rotation (re-encrypting all stored tokens with a new key) should be documented as an operational procedure but is not automated in the initial implementation.

**Nonce handling:** AES-GCM requires a unique nonce (IV) per encryption operation. A fresh 12-byte random nonce is generated for each encrypt call and stored alongside the ciphertext (prepended to the stored value). The auth tag is also stored as part of the ciphertext blob, enabling tamper detection on decryption.

---

## OAuth: Authorization Code Flow with PKCE

The connector implements the Authorization Code flow with PKCE as specified. PKCE (Proof Key for Code Exchange) ensures that even if the authorization code is intercepted in transit, it cannot be exchanged for tokens without the corresponding code verifier, which never leaves the server.

The PKCE code verifier is generated as a cryptographically random 43–128 character string. The code challenge is derived from it using the S256 method (SHA-256 hash, base64url-encoded).

The `state` parameter (a random string stored in the `oauth_state` table alongside the code verifier) prevents CSRF attacks against the callback endpoint.

---

## Access Token Caching and Refresh Strategy

Google access tokens expire after one hour. Rather than refreshing on every request (wasteful) or waiting for a 401 to trigger a refresh (adds latency for the user), the connector uses **proactive expiry-based refresh**:

1. The access token and its expiry timestamp are stored in the `oauth_tokens` table alongside the refresh token.
2. On each incoming tool call, the server reads the stored access token and checks whether it expires within the next five minutes.
3. If it does (or if no valid access token is stored), the server uses the refresh token to obtain a new access token from Google and updates the stored values before proceeding.
4. Otherwise, the cached access token is used directly.

This means most requests use the cached token with a single database read rather than a round-trip to Google's token endpoint.

---

## Input Validation: Zod

All tool inputs are validated with [Zod](https://zod.dev) before any processing occurs. The MCP SDK's tool-definition API accepts Zod schemas natively, so schema definitions double as both MCP tool input descriptors and runtime validators with no duplication.

Server-side enforcement rules (blocking `TRASH` and `SPAM` label IDs, validating that provided label IDs exist in the user's label list before submitting write requests to Google) are implemented as Zod refinements or as post-validation checks in the tool handler, per the requirements in the technical specification.

---

## Logging: Pino

[Pino](https://getpino.io) is the structured logger. It is Fastify's native logger and produces newline-delimited JSON by default, which is compatible with every major log aggregation platform. It is also the fastest Node.js logger by a significant margin.

Logging rules:
- All tool invocations are logged at `info` level with: user ID, tool name, duration, and success/failure status.
- All write operations (label modifications) are additionally logged at `info` level with the affected message/thread IDs and the label IDs added/removed. This constitutes the audit log.
- OAuth flow events (authorization initiated, token issued, token refreshed) are logged at `info` level with user ID but no token values.
- **Refresh tokens, access tokens, and encryption keys are never logged at any level.**
- Error responses from the Gmail API are logged at `warn` level (expected errors, e.g., 404) or `error` level (unexpected errors, e.g., 5xx).

---

## Secrets Management

At minimum, the following secrets are provided to the server as environment variables:

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key (base64-encoded) for AES-256-GCM token encryption |
| `DATABASE_URL` | PostgreSQL connection string |

These values must never be committed to source control. A `.env.example` file (with placeholder values, not real secrets) should be committed to document the required variables.

For production deployments, a secrets manager (Doppler, AWS Secrets Manager, or the hosting platform's native secrets facility) should be used in preference to plain environment variable files.

---

## Testing

### Framework: Vitest

[Vitest](https://vitest.dev) is the testing framework. It is chosen over Jest because it has native TypeScript support without requiring `ts-jest` or Babel transforms, making it faster to configure and faster to run. Its API is intentionally compatible with Jest (`describe`, `it`/`test`, `expect`, `vi.fn()`, `vi.spyOn()`, etc.), so Jest experience transfers directly. Vitest also has first-class support for ES modules, which matters since the MCP SDK and `postgres` are both ESM packages.

The test runner is invoked via:
```
vitest run          # run all tests once (CI)
vitest              # watch mode (development)
vitest --coverage   # run with coverage report
```

Coverage is collected using Vitest's built-in V8 coverage provider (no separate Istanbul setup required). A coverage threshold of 90% line coverage is enforced in CI; the goal during development is to cover 100% of the tool-handler logic and all OAuth flow paths.

### Mocking: MSW (Mock Service Worker)

[MSW](https://mswjs.io) (Mock Service Worker) is used to intercept and mock all outbound HTTP requests during tests — both Gmail API calls and Google OAuth token endpoint calls. MSW operates at the network layer using Node's `http` interception, meaning the application code under test runs exactly as it would in production, with no modification to make it "testable." The mocks live in a dedicated `src/mocks/` directory and are activated in the test setup file.

This approach is deliberately chosen over Vitest's built-in module mocking (`vi.mock`) for the HTTP layer because MSW:
- Intercepts at the network level, not the module level — so the full request-building code path (including headers, query parameters, and auth token injection) is exercised.
- Makes mocks reusable across unit and integration tests.
- Produces tests that can trivially be switched to hit the real API (by not activating MSW) for manual end-to-end validation.

MSW handler files define the expected Gmail API responses for each tool:
```
src/mocks/
  handlers/
    gmail-labels.ts      # GET /labels responses
    gmail-messages.ts    # GET /messages, GET /messages/:id, POST /messages/batchModify, etc.
    gmail-threads.ts     # GET /threads, GET /threads/:id, POST /threads/:id/modify
    gmail-profile.ts     # GET /profile
    gmail-history.ts     # GET /history
    google-oauth.ts      # POST /token (token refresh endpoint)
  server.ts              # MSW Node server setup, imported by test setup file
```

### Database: Test Isolation with a Real Postgres Instance

For database-touching tests, a real Postgres instance is used rather than a mock. The recommended local setup is [Docker Compose](https://docs.docker.com/compose/), with a single `docker-compose.yml` in the repository that spins up a Postgres container on a test port:

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: gmail_organizer_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"
```

A Vitest global setup file (`vitest.setup.ts`) runs migrations against this database before the test suite starts, and a global teardown truncates all tables between test files. This means every developer can run the full test suite with `docker compose up -d && vitest run` and get a clean, reproducible result with no manual state management.

The `DATABASE_URL` for tests points to the Docker Compose instance and is set in a `.env.test` file (which can be committed since it contains no real secrets).

### What the Tests Cover

The following test categories together allow 100% of the system's capabilities to be verified on a developer's machine with no live external dependencies:

**Unit tests** (`src/**/*.test.ts`):
- Each of the 11 MCP tool handlers (correct request construction, correct response transformation, error handling for each error code)
- Token encryption/decryption (including tamper detection, nonce uniqueness)
- Access token refresh logic (proactive refresh, post-401 refresh retry, caching behavior)
- Label ID validation (TRASH/SPAM blocking, existence checking)
- MIME body decoding (base64url decode of message bodies and attachments)
- Rate limiting logic
- Input validation (Zod schema enforcement for each tool's input parameters)

**Integration tests** (`src/**/*.integration.test.ts`):
- The full OAuth flow: authorization redirect construction → callback handling → token storage → token retrieval
- The full request lifecycle for each tool: incoming MCP POST → user identity extraction → token lookup → Gmail API call (mocked by MSW) → response returned to caller
- Database schema integrity (migrations apply cleanly to a fresh database)
- PKCE code verifier round-trip (generated, stored, retrieved, verified)

**End-to-end manual validation** (not automated):
- Connecting the live server to a personal Google account in Claude's settings and exercising each tool interactively. This step requires a real Google account added as a test user on the OAuth consent screen during development, as described in the technical specification.

### Running Tests Locally

Prerequisites: Docker (for Postgres), Node.js 20+.

```bash
# Start the test database
docker compose up -d

# Install dependencies
npm install

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run coverage
```

The `package.json` scripts should be configured so that `npm test` is the single command a developer needs to run to validate the entire system.

---

## Summary Table

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict mode) | Best MCP SDK support; type safety for credential handling |
| MCP SDK | `@modelcontextprotocol/sdk` (official) | Stability; required for directory submission |
| MCP Transport | Streamable HTTP, stateless mode | Current standard; simplest scaling model for this use case |
| HTTP Framework | Fastify | Performance; TypeScript support; native Pino integration |
| Rate Limiting | `@fastify/rate-limit` | Per-user abuse prevention; Google quota protection |
| Database | PostgreSQL | Durable encrypted token storage |
| Database Client | `postgres` (postgres.js) | No ORM abstraction; plain SQL; built-in pooling |
| ORM | None | Schema is simple; queries are plain SQL; no migration framework lock-in |
| Token Encryption | AES-256-GCM, application-level | Plaintext never reaches the database |
| OAuth Flow | Authorization Code + PKCE | Required by spec; protects against code interception |
| OAuth State Storage | Short-TTL `oauth_state` table | Avoids adding Redis; uses existing Postgres dependency |
| Access Token Strategy | Cache with expiry; proactive refresh | Minimizes round-trips to Google's token endpoint |
| Input Validation | Zod | Native to MCP SDK; runtime validation + type inference |
| Logging | Pino (structured JSON) | Native to Fastify; production-grade; no sensitive data logged |
| Secrets | Environment variables + secrets manager | Standard; encryption key and OAuth credentials never committed |
| Testing Framework | Vitest | Native TypeScript; fast; Jest-compatible API |
| HTTP Mocking | MSW (Mock Service Worker) | Network-level interception; tests the full request path |
| Database in Tests | Real Postgres via Docker Compose | Accurate; no mock drift; reproducible on any developer machine |
| Hosting | Not specified — see separate decision | Deferred |
