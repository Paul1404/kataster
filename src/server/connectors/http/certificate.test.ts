import { execFileSync, spawn } from "node:child_process";
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
  let connections = 0;
  server.on("connection", () => connections++);
  server.on("tlsClientError", () => {});
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    expect(await readCertificate("127.0.0.1", address.port, 2000)).toBeNull();
    expect(connections).toBe(1);
    // Vitest runs in Node. Also exercise the Bun runtime used in production.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "bun",
        [
          "--eval",
          `const {readCertificate}=await import("./src/server/connectors/http/http.connector.ts");
         const cert=await readCertificate("127.0.0.1",${address.port},2000);
         if(cert!==null)throw new Error("Untrusted certificate accepted");`,
        ],
        { stdio: "pipe" },
      );
      let error = "";
      child.stderr.on("data", (chunk) => {
        error += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
    });
    expect(connections).toBe(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
