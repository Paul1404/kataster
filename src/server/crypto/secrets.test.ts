import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// Set a valid 32-byte key before importing the module under test.
beforeAll(() => {
  process.env.LFIO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("secrets", () => {
  it("round-trips an object through encrypt/decrypt", async () => {
    const { encryptSecret, decryptSecret } = await import("./secrets");
    const secret = { accessKeyId: "AKIA123", secretAccessKey: "abc/def+ghi" };
    const blob = encryptSecret(secret);
    expect(blob.split(":")).toHaveLength(3);
    expect(blob).not.toContain("AKIA123");
    expect(decryptSecret(blob)).toEqual(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const { encryptSecret } = await import("./secrets");
    const a = encryptSecret({ x: 1 });
    const b = encryptSecret({ x: 1 });
    expect(a).not.toEqual(b);
  });

  it("fails to decrypt a tampered blob (auth tag)", async () => {
    const { encryptSecret, decryptSecret } = await import("./secrets");
    const blob = encryptSecret({ token: "sensitive" });
    const [iv, tag, data] = blob.split(":");
    // Flip a byte in the ciphertext.
    const tamperedData = Buffer.from(data!, "base64");
    tamperedData[0] = tamperedData[0]! ^ 0xff;
    const tampered = [iv, tag, tamperedData.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed blob", async () => {
    const { decryptSecret } = await import("./secrets");
    expect(() => decryptSecret("not-a-valid-blob")).toThrow("malformed secret blob");
  });

  it("rejects a key of the wrong length", async () => {
    const prev = process.env.LFIO_ENCRYPTION_KEY;
    process.env.LFIO_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    const { encryptSecret } = await import("./secrets");
    expect(() => encryptSecret({ a: 1 })).toThrow("32 bytes");
    process.env.LFIO_ENCRYPTION_KEY = prev;
  });
});
