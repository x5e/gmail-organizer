/**
 * src/config.ts
 *
 * Loads and validates required environment variables at startup.
 * All other modules import from here rather than reading process.env directly,
 * so misconfiguration fails fast with a clear message before any requests are served.
 *
 * Required environment variables:
 *   GOOGLE_CLIENT_ID          — OAuth 2.0 client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET      — OAuth 2.0 client secret
 *   TOKEN_ENCRYPTION_KEY      — 32-byte AES-256-GCM key, base64-encoded
 *   DATABASE_URL              — PostgreSQL connection string
 *   BASE_URL                  — Public HTTPS base URL of this server (for OAuth callback)
 *
 * Optional:
 *   PORT                      — HTTP listen port (default: 3000)
 *   LOG_LEVEL                 — Pino log level (default: "info")
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Parsed and validated application configuration. */
export const config = {
  /** Google OAuth 2.0 client ID. */
  googleClientId: requireEnv("GOOGLE_CLIENT_ID"),

  /** Google OAuth 2.0 client secret. */
  googleClientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),

  /**
   * AES-256-GCM encryption key for OAuth refresh tokens.
   * Must be exactly 32 bytes when base64-decoded.
   */
  tokenEncryptionKey: requireEnv("TOKEN_ENCRYPTION_KEY"),

  /** PostgreSQL connection string. */
  databaseUrl: requireEnv("DATABASE_URL"),

  /**
   * Public base URL of this server (e.g. https://your-domain.com).
   * Used to construct the OAuth callback URL registered with Google.
   */
  baseUrl: requireEnv("BASE_URL"),

  /** HTTP listen port. */
  port: parseInt(process.env["PORT"] ?? "3000", 10),

  /** Pino log level. */
  logLevel: process.env["LOG_LEVEL"] ?? "info",

  /** Full OAuth callback URL derived from BASE_URL. */
  get oauthCallbackUrl(): string {
    return `${this.baseUrl}/oauth/callback`;
  },
} as const;
