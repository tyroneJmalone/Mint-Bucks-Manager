import { defineConfig } from "vitest/config";

/**
 * Derive the test database URL.
 *
 * Priority:
 *   1. TEST_DATABASE_URL env var (set this in CI / other environments)
 *   2. DATABASE_URL with the db name swapped to "mintbucks_test"
 *
 * The mintbucks_test database must exist and have the schema applied:
 *   DATABASE_URL=<test-url> pnpm --filter @workspace/db exec drizzle-kit push --force
 *
 * This construction avoids hard-coding any host or credential — it reuses
 * whatever host/user/password the app database already uses.
 */
function testDbUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL ?? "";
  // Replace the database name (path segment before optional ?query) with mintbucks_test.
  return appUrl.replace(/\/([^/?]+)(\?|$)/, "/mintbucks_test$2");
}

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Run sequentially — tests manipulate shared tables in the test database
    // and must not race with each other.
    singleFork: true,
    testTimeout: 30_000,
    hookTimeout: 20_000,
    // Override DATABASE_URL before any module is imported so the @workspace/db
    // singleton connects to the isolated test database, not the app database.
    env: {
      DATABASE_URL: testDbUrl(),
    },
  },
});
