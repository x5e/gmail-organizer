/**
 * src/mocks/server.ts
 *
 * Sets up and exports the MSW (Mock Service Worker) Node.js server used in tests.
 *
 * Import `mswServer` in test setup files to activate/deactivate HTTP interception.
 * The server intercepts all outbound HTTP requests from the application code and
 * returns mock responses, allowing the full request-building code path (including
 * auth headers, query parameters, and JSON body construction) to be exercised
 * without real network calls.
 *
 * Usage in test setup:
 *   import { mswServer } from '../mocks/server.js';
 *   beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => mswServer.resetHandlers());
 *   afterAll(() => mswServer.close());
 */

import { setupServer } from "msw/node";
import { gmailLabelsHandlers } from "./handlers/gmail-labels.js";
import { gmailMessagesHandlers } from "./handlers/gmail-messages.js";
import { gmailThreadsHandlers } from "./handlers/gmail-threads.js";
import { gmailProfileHandlers } from "./handlers/gmail-profile.js";
import { gmailHistoryHandlers } from "./handlers/gmail-history.js";
import { googleOAuthHandlers } from "./handlers/google-oauth.js";

/** The MSW Node server with all Gmail API and OAuth mock handlers registered. */
export const mswServer = setupServer(
  ...gmailLabelsHandlers,
  ...gmailMessagesHandlers,
  ...gmailThreadsHandlers,
  ...gmailProfileHandlers,
  ...gmailHistoryHandlers,
  ...googleOAuthHandlers
);
