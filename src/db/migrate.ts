/**
 * src/db/migrate.ts
 *
 * Simple SQL migration runner.
 *
 * Reads *.sql files from the migrations/ directory (relative to the project
 * root), applies any that have not yet been recorded in schema_migrations, and
 * records each successfully applied migration.
 *
 * Files are applied in lexicographic order (001_initial.sql before
 * 002_something.sql, etc.), so numbering must be kept consistent.
 *
 * This module is used in two ways:
 *   1. Called at server startup (src/server.ts) to ensure the schema is current.
 *   2. Executed standalone via `npm run migrate` for manual migration runs.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

/**
 * Applies all unapplied SQL migration files found in the migrations/ directory.
 *
 * @param sql - A postgres.js connection instance. Defaults to the shared pool
 *              if not provided (for standalone usage via `npm run migrate`).
 */
export async function runMigrations(sql: postgres.Sql): Promise<void> {
  // Ensure schema_migrations table exists (idempotent — safe to run on every startup).
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Load list of already-applied migrations.
  const applied = await sql<{ filename: string }[]>`
    SELECT filename FROM schema_migrations ORDER BY filename
  `;
  const appliedSet = new Set(applied.map((r) => r.filename));

  // Read migration files sorted lexicographically.
  let files: string[];
  try {
    const all = await readdir(MIGRATIONS_DIR);
    files = all.filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.warn(`No migrations directory found at ${MIGRATIONS_DIR}; skipping.`);
    return;
  }

  for (const filename of files) {
    if (appliedSet.has(filename)) {
      continue;
    }

    const sqlText = await readFile(join(MIGRATIONS_DIR, filename), "utf8");

    // Run the migration and record it atomically.
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`
        INSERT INTO schema_migrations (filename) VALUES (${filename})
      `;
    });

    console.log(`Applied migration: ${filename}`);
  }
}

// Allow standalone execution: `tsx src/db/migrate.ts`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { sql: pool } = await import("./index.js");
  try {
    await runMigrations(pool);
    console.log("Migrations complete.");
  } finally {
    await pool.end();
  }
}
