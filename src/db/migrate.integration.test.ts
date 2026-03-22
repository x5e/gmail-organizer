/**
 * src/db/migrate.integration.test.ts
 *
 * Integration tests for the database migration runner.
 *
 * Covers:
 *   - Migrations apply cleanly to a fresh database
 *   - All expected tables exist after migration
 *   - Running migrations twice is idempotent (no error on re-run)
 *   - schema_migrations table tracks applied filenames
 */

import { describe, it, expect, afterAll } from "vitest";
import { createTestDb } from "../test/db-helpers.js";
import { runMigrations } from "./migrate.js";

const db = createTestDb();

afterAll(async () => {
  await db.end();
});

describe("runMigrations", () => {
  it("creates all expected tables", async () => {
    // Migrations already ran in global-setup; just verify the tables exist.
    const tables = await db<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const tableNames = tables.map((t) => t.tablename);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("oauth_tokens");
    expect(tableNames).toContain("oauth_state");
    expect(tableNames).toContain("schema_migrations");
  });

  it("is idempotent — running again does not error", async () => {
    await expect(runMigrations(db)).resolves.toBeUndefined();
  });

  it("records migrations in schema_migrations", async () => {
    const rows = await db<{ filename: string }[]>`
      SELECT filename FROM schema_migrations ORDER BY filename
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.filename).toBe("001_initial.sql");
  });

  it("users table has correct columns", async () => {
    const columns = await db<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY column_name
    `;
    const colMap = Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]));
    expect(colMap["id"]).toBe("uuid");
    expect(colMap["created_at"]).toBe("timestamp with time zone");
  });

  it("oauth_tokens table has encrypted_refresh_token as bytea", async () => {
    const columns = await db<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'oauth_tokens'
    `;
    const colMap = Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]));
    expect(colMap["encrypted_refresh_token"]).toBe("bytea");
  });
});
