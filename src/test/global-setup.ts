/**
 * src/test/global-setup.ts
 *
 * Vitest global setup — runs once before all test files.
 *
 * Responsibilities:
 *   1. Waits for the Postgres test container to be ready.
 *   2. Runs all database migrations against the test database.
 *
 * This file is referenced in vitest.config.ts under `test.globalSetup`.
 * It runs in a separate Node.js process from the tests themselves.
 */

import postgres from "postgres";
import { runMigrations } from "../db/migrate.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://test:test@localhost:5433/gmail_organizer_test";

/** Maximum time to wait for Postgres to become available. */
const MAX_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 500;

/**
 * Polls the database until it accepts connections or the timeout expires.
 */
async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const testSql = postgres(url, { max: 1, connect_timeout: 3 });
    try {
      await testSql`SELECT 1`;
      await testSql.end();
      return;
    } catch {
      await testSql.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }

  throw new Error(
    `Postgres did not become available within ${MAX_WAIT_MS}ms. ` +
      "Is `docker compose up -d` running?"
  );
}

/**
 * Global setup function called by Vitest before any test files run.
 */
export async function setup(): Promise<() => Promise<void>> {
  await waitForDatabase(DATABASE_URL);

  const sql = postgres(DATABASE_URL, { max: 5 });
  try {
    await runMigrations(sql);
  } finally {
    await sql.end();
  }

  console.log("✓ Database ready and migrations applied.");

  // Return a teardown function (optional).
  return async () => {
    // Nothing to tear down globally — per-file cleanup is done in setup.ts.
  };
}
