import { describe, expect, it } from "vitest";
import { ensureBaseUrl } from "./url";

describe("ensureBaseUrl", () => {
  it("prepends https:// when no scheme is given", () => {
    expect(ensureBaseUrl("mail.example.com")).toBe("https://mail.example.com");
  });
  it("keeps an existing scheme", () => {
    expect(ensureBaseUrl("http://mail.example.com")).toBe("http://mail.example.com");
    expect(ensureBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
  });
  it("strips trailing slashes and trims", () => {
    expect(ensureBaseUrl("  https://mail.example.com/  ")).toBe("https://mail.example.com");
    expect(ensureBaseUrl("mail.example.com//")).toBe("https://mail.example.com");
  });
});
