import { describe, expect, it } from "vitest";
import { normFqdn } from "./ci";

describe("normFqdn", () => {
  it("lowercases, trims, and strips a trailing dot", () => {
    expect(normFqdn("Web.EXAMPLE.test.")).toBe("web.example.test");
    expect(normFqdn("  HOST.example.com  ")).toBe("host.example.com");
    expect(normFqdn("web.example.test")).toBe("web.example.test");
  });

  it("returns null for empty/absent input", () => {
    expect(normFqdn("")).toBeNull();
    expect(normFqdn("   ")).toBeNull();
    expect(normFqdn(null)).toBeNull();
    expect(normFqdn(undefined)).toBeNull();
  });
});
