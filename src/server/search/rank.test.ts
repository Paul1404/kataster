import { describe, expect, it } from "vitest";
import { rankMatches, scoreMatch } from "./rank";

describe("scoreMatch", () => {
  it("is case insensitive", () => {
    expect(scoreMatch("WEB", { name: "web.example.test" })).toBeGreaterThan(0);
    expect(scoreMatch("web", { name: "WEB.example.test" })).toBeGreaterThan(0);
  });

  it("ranks exact over prefix over substring", () => {
    const exact = scoreMatch("mail", { name: "mail" });
    const prefix = scoreMatch("mail", { name: "mailcow" });
    const inside = scoreMatch("mail", { name: "primary-mailserver" });
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
  });

  it("prefers a name match over an external id match", () => {
    const byName = scoreMatch("abc", { name: "abc-host", externalId: "zzz" });
    const byId = scoreMatch("abc", { name: "zzz-host", externalId: "abc-1" });
    expect(byName).toBeGreaterThan(byId);
  });

  it("returns zero for no match and for an empty query", () => {
    expect(scoreMatch("nope", { name: "web", externalId: "srv-1" })).toBe(0);
    expect(scoreMatch("  ", { name: "web" })).toBe(0);
  });
});

describe("rankMatches", () => {
  it("drops non-matches, orders by score and caps the result", () => {
    const items = [
      { name: "postfach@example.de" },
      { name: "example.de" },
      { name: "shop.example.de" },
      { name: "unrelated" },
    ];
    expect(rankMatches("example", items, 2).map((i) => i.name)).toEqual([
      "example.de",
      "shop.example.de",
    ]);
  });

  it("breaks ties by length and then by name", () => {
    const items = [{ name: "beta-web" }, { name: "alpha-web" }, { name: "acme-web" }];
    expect(rankMatches("web", items, 5).map((i) => i.name)).toEqual([
      "acme-web",
      "beta-web",
      "alpha-web",
    ]);
  });
});
