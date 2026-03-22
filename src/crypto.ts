/**
 * src/crypto.ts
 *
 * Application-level AES-256-GCM encryption for OAuth refresh tokens.
 *
 * Refresh tokens are long-lived credentials granting ongoing access to a
 * user's Gmail account. They are encrypted before being written to the database
 * so that a database credential leak alone cannot recover plaintext token values.
 *
 * Storage format: nonce (12 bytes) || ciphertext || authTag (16 bytes)
 * All concatenated into a single Buffer stored as BYTEA in Postgres.
 *
 * The encryption key comes from the TOKEN_ENCRYPTION_KEY environment variable
 * (a 32-byte value, base64-encoded).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const NONCE_LENGTH = 12; // 96-bit nonce recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt (e.g. a refresh token).
 * @param keyBase64 - Base64-encoded 32-byte encryption key.
 * @returns Buffer containing nonce || ciphertext || authTag.
 */
export function encrypt(plaintext: string, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be 32 bytes; got ${key.length}. ` +
        `Ensure TOKEN_ENCRYPTION_KEY is a base64-encoded 32-byte value.`
    );
  }

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([nonce, ciphertext, authTag]);
}

/**
 * Decrypts a Buffer produced by `encrypt` using AES-256-GCM.
 *
 * Throws if the auth tag does not match (i.e. the ciphertext has been tampered
 * with or the wrong key was used).
 *
 * @param cipherBlob - Buffer containing nonce || ciphertext || authTag.
 * @param keyBase64 - Base64-encoded 32-byte encryption key (must match encrypt key).
 * @returns The decrypted plaintext string.
 */
export function decrypt(cipherBlob: Buffer, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be 32 bytes; got ${key.length}.`
    );
  }

  if (cipherBlob.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Cipher blob is too short to contain nonce and auth tag.");
  }

  const nonce = cipherBlob.subarray(0, NONCE_LENGTH);
  const authTag = cipherBlob.subarray(cipherBlob.length - AUTH_TAG_LENGTH);
  const ciphertext = cipherBlob.subarray(NONCE_LENGTH, cipherBlob.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
