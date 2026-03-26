/**
 * Vitest configuration for the Gmail Organizer MCP connector.
 *
 * - Uses the V8 coverage provider (no separate Istanbul setup).
 * - Loads .env.test for DATABASE_URL and other test-specific env vars.
 * - Runs globalSetup before any test file (applies migrations, starts MSW).
 * - Enforces 90% line coverage threshold in CI.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Run test files sequentially — all test files share the same Postgres container,
    // and parallel file execution causes cross-file truncation races.
    fileParallelism: false,
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    env: {
      // Test environment overrides — no real secrets
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      // 32-byte key base64-encoded (dummy, for tests only — not a real secret)
      TOKEN_ENCRYPTION_KEY: "RPo3D2ZLeaTM3gyoxkOdT0BE7vxKFTkJ6Im7MCGiSJA=",
      DATABASE_URL:
        process.env.DATABASE_URL ||
        "postgres://test:test@localhost:5433/gmail_organizer_test",
      BASE_URL: "http://localhost:3000",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/test/**",
        "src/mocks/**",
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/server.ts", // entry point — covered by integration tests
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 75, // Write-tool error-path branches (404/401/429) are hard to exercise
        statements: 90,
      },
    },
  },
});
