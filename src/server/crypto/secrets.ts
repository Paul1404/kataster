/**
 * Symmetric encryption for connector credentials at rest.
 * AES-256-GCM with a 32-byte master key from LFIO_ENCRYPTION_KEY (base64).
 * Server-only. Never import from client code.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey(): Buffer {
  const raw = process.env.LFIO_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("LFIO_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("LFIO_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  return key;
}

/** Call at process startup to fail fast on a missing/malformed key. */
export function assertEncryptionKey(): void {
  getKey();
}

/** Encrypt an object to a `iv:authTag:ciphertext` base64 string. */
export function encryptSecret(value: Record<string, unknown>): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

/** Decrypt a blob produced by encryptSecret back to its object. */
export function decryptSecret<T = Record<string, unknown>>(blob: string): T {
  const key = getKey();
  const parts = blob.split(":");
  if (parts.length !== 3) {
    throw new Error("malformed secret blob");
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
