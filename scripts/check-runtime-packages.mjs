import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.notEqual(process.getuid(), 0, "The application image must run as non-root");
const removed = readFileSync("/usr/local/share/runtime-pruning.txt", "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t")[0])
  .filter(Boolean);
assert.ok(removed.length >= 8, "The image must contain the package-pruning result");
for (const name of removed) {
  let status = "";
  try {
    status = execFileSync("dpkg-query", ["-W", "-f=${db:Status-Status}", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A purged package normally has no dpkg entry.
  }
  assert.notEqual(status, "installed", `${name} was reintroduced into the image`);
}
execFileSync("/bin/sh", ["-c", "id -u >/dev/null && test -w /tmp"]);
console.log(
  JSON.stringify({ runtimePackagesRemoved: removed.length, uid: process.getuid(), removed }),
);

if (process.argv.includes("--pdf")) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-pdf-check-"));
  try {
    const text = "BT /F1 10 Tf 5 50 Td (Pruned runtime PDF) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, value] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const file = join(dir, "input.pdf");
    writeFileSync(file, pdf);
    const output = execFileSync("pdftotext", [file, "-"], { encoding: "utf8", timeout: 10000 });
    assert.ok(output.includes("Pruned runtime PDF"));
    execFileSync("pdftoppm", ["-singlefile", "-scale-to", "64", "-png", file, join(dir, "page")], {
      timeout: 10000,
    });
    assert.ok(
      readFileSync(join(dir, "page.png"))
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    console.log("Production PDF text extraction and rasterization passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv.includes("--sc")) {
  const version = execFileSync("sc", ["--version"], { encoding: "utf8", timeout: 10000 });
  assert.ok(version.includes("1.2.0"));
  console.log("Signed Scalable CLI runtime loading passed");
}
