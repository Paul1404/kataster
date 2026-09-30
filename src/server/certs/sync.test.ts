import { describe, expect, it } from "vitest";
import { buildCertRows } from "./sync";

describe("buildCertRows", () => {
  it("normalizes common name + SANs and parses notAfter to a Date", () => {
    const rows = buildCertRows("asset-1", "tls", [
      {
        commonName: "Example.COM.",
        sans: ["example.com", "WWW.example.com."],
        issuer: "Let's Encrypt",
        notAfter: "2026-09-01T00:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commonName).toBe("example.com");
    expect(rows[0]!.sans).toEqual(["example.com", "www.example.com"]);
    expect(rows[0]!.source).toBe("tls");
    expect(rows[0]!.notAfter).toBeInstanceOf(Date);
  });

  it("dedupes by common name and skips blanks", () => {
    const rows = buildCertRows("asset-1", "acm", [
      { commonName: "a.com", notAfter: null },
      { commonName: "a.com", notAfter: "2027-01-01T00:00:00.000Z" },
      { commonName: "", notAfter: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notAfter).toBeInstanceOf(Date);
  });
});
