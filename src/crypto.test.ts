/**
 * src/crypto.test.ts
 *
 * Unit tests for AES-256-GCM token encryption.
 *
 * Covers:
 *   - Basic encrypt/decrypt round-trip
 *   - Nonce uniqueness (each encrypt call produces a different ciphertext)
 *   - Tamper detection (auth tag failure on modified ciphertext)
 *   - Wrong key rejection
 *   - Edge cases: empty string, unicode, long strings
 *   - Invalid key length rejection
 *   - Invalid cipher blob (too short)
 */

import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto.js";

// A valid 32-byte key base64-encoded (same as test env — not a real secret).
const TEST_KEY = "RPo3D2ZLeaTM3gyoxkOdT0BE7vxKFTkJ6Im7MCGiSJA=";
const WRONG_KEY = Buffer.from("a".repeat(32)).toString("base64");

describe("encrypt / decrypt", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "my-refresh-token-12345";
    const blob = encrypt(plaintext, TEST_KEY);
    const result = decrypt(blob, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const blob = encrypt("", TEST_KEY);
    expect(decrypt(blob, TEST_KEY)).toBe("");
  });

  it("round-trips a unicode string", () => {
    const plaintext = "refresh-token-こんにちは-🔑";
    const blob = encrypt(plaintext, TEST_KEY);
    expect(decrypt(blob, TEST_KEY)).toBe(plaintext);
  });

  it("round-trips a long string (1KB)", () => {
    const plaintext = "x".repeat(1024);
    const blob = encrypt(plaintext, TEST_KEY);
    expect(decrypt(blob, TEST_KEY)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (nonce uniqueness)", () => {
    const plaintext = "same-input";
    const blob1 = encrypt(plaintext, TEST_KEY);
    const blob2 = encrypt(plaintext, TEST_KEY);
    // The blobs must differ because each uses a fresh random nonce.
    expect(blob1.equals(blob2)).toBe(false);
    // Both must decrypt correctly.
    expect(decrypt(blob1, TEST_KEY)).toBe(plaintext);
    expect(decrypt(blob2, TEST_KEY)).toBe(plaintext);
  });

  it("throws when decrypting with the wrong key", () => {
    const blob = encrypt("secret", TEST_KEY);
    expect(() => decrypt(blob, WRONG_KEY)).toThrow();
  });

  it("throws when the ciphertext has been tampered with", () => {
    const blob = encrypt("secret", TEST_KEY);
    // Flip a byte in the ciphertext portion (after the 12-byte nonce).
    const tampered = Buffer.from(blob);
    tampered[12] = tampered[12]! ^ 0xff;
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("throws when the auth tag has been tampered with", () => {
    const blob = encrypt("secret", TEST_KEY);
    // Flip a byte in the last 16 bytes (the auth tag).
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("throws on an invalid key length (too short)", () => {
    const shortKey = Buffer.from("short").toString("base64");
    expect(() => encrypt("data", shortKey)).toThrow(/32 bytes/);
  });

  it("throws on a cipher blob that is too short", () => {
    const tinyBlob = Buffer.alloc(10); // less than nonce (12) + authTag (16)
    expect(() => decrypt(tinyBlob, TEST_KEY)).toThrow(/too short/);
  });
});
