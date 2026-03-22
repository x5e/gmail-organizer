/**
 * src/test/setup.ts
 *
 * Vitest per-file setup — runs before each test file.
 *
 * Responsibilities:
 *   1. Starts the MSW server to intercept HTTP requests.
 *   2. Resets MSW handlers between tests to avoid test pollution.
 *   3. Closes MSW after all tests in the file complete.
 *
 * This file is referenced in vitest.config.ts under `test.setupFiles`.
 */

import { beforeAll, afterEach, afterAll } from "vitest";
import { mswServer } from "../mocks/server.js";

beforeAll(() => {
  // Start MSW and throw on any unhandled requests (catches missing mock handlers).
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  // Reset any runtime handler overrides added within individual tests.
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});
