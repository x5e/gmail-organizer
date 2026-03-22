/**
 * src/db/index.ts
 *
 * PostgreSQL database client using the `postgres` (postgres.js) package.
 *
 * Exports a single `sql` tagged-template function that serves as the database
 * connection pool for the entire application. All queries use this instance.
 *
 * The connection string is read from DATABASE_URL (see src/config.ts).
 * Connection pooling is handled automatically by postgres.js.
 *
 * Usage:
 *   import { sql } from './db/index.js';
 *   const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;
 */

import postgres from "postgres";
import { config } from "../config.js";

/** Shared postgres.js connection pool for the application. */
export const sql = postgres(config.databaseUrl, {
  max: 10, // maximum pool size
  idle_timeout: 30, // close idle connections after 30s
  connect_timeout: 10, // fail after 10s if can't connect
  types: {}, // use default type parsers
});

/** Gracefully closes the database connection pool. */
export async function closeDb(): Promise<void> {
  await sql.end();
}
