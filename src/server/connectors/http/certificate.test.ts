import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { expect, it } from "vitest";
import { readCertificate } from "./http.connector";

it("rejects an untrusted TLS certificate instead of recording it as authenticated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kataster-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) });
  server.on("tlsClientError", () => {});
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    expect(await readCertificate("localhost", address.port, 2000)).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
