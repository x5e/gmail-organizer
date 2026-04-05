# Test Notes

## Setup

Tests require a running Postgres container. `npm test` starts it automatically via Docker Compose:

```
npm test   # docker compose up -d && vitest run
```

The container runs `postgres:16-alpine` on port **5433** (not the default 5432, to avoid clashing
with a local Postgres instance). Migrations are applied automatically before the first test file
runs (`src/test/global-setup.ts`).

All test files share one container and must run sequentially — see `fileParallelism: false` in
`vitest.config.ts`. Each test file truncates tables in `beforeEach` to isolate state.

---

## MSW (Mock Service Worker)

Gmail API calls and Google OAuth token requests are intercepted by MSW handlers in `src/mocks/`.

- **`valid_auth_code`** — the Google auth code that MSW treats as valid; use this in callback URLs.
- **`invalid-token`** — any access token with this value triggers a 401 from all Gmail mock
  handlers, simulating an expired token.
- **`invalid_refresh_token`** — causes the MSW OAuth token handler to return 400, simulating a
  fully-revoked credential.

---

## Testing SSE (GET /mcp) — Known Limitation

`GET /mcp` opens a **Server-Sent Events stream** that stays open indefinitely — the server only
sends events in response to MCP tool calls, so there is nothing to close the stream in a unit
test context.

As a result, **`app.inject()` hangs** when you send an authenticated `GET /mcp` request with
`Accept: text/event-stream`. The inject call collects the response body, but the SSE stream
never ends, so it waits forever.

### Workaround used in tests

Test authenticated GET /mcp by omitting the `Accept: text/event-stream` header. The MCP
transport enforces this header and returns **406 Not Acceptable** immediately. A 406 proves:

1. Auth passed (would be 401 otherwise).
2. The route exists and is wired (would be 404 otherwise).
3. The request reached the MCP transport (which owns the 406).

```typescript
const response = await app.inject({
  method: "GET",
  url: "/mcp",
  // No Accept: text/event-stream — transport returns 406 immediately, no hang
  headers: { Authorization: `Bearer ${bearerToken}` },
});
expect(response.statusCode).toBe(406); // transport enforcement, not a routing failure
```

If you ever need to test actual SSE streaming end-to-end, use a real HTTP client against a
running server (e.g. `EventSource` or `curl -N`) rather than `app.inject()`.
