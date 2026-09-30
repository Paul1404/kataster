import { describe, expect, it } from "vitest";
import {
  buildGroups,
  EMPTY_PALETTE_DATA,
  flattenGroups,
  matchPages,
  moveIndex,
  PALETTE_PAGES,
} from "./command-palette";

describe("matchPages", () => {
  it("offers every page for an empty query", () => {
    expect(matchPages("  ")).toHaveLength(PALETTE_PAGES.length);
  });

  it("matches case-insensitively on the German label", () => {
    expect(matchPages("abrech").map((p) => p.to)).toEqual(["/billing"]);
    expect(matchPages("KUNDEN").map((p) => p.to)).toEqual(["/customers"]);
  });

  it("returns nothing for an unknown page", () => {
    expect(matchPages("zzz")).toEqual([]);
  });
});

describe("buildGroups", () => {
  it("shows only pages when nothing was found", () => {
    const groups = buildGroups("kosten", EMPTY_PALETTE_DATA);
    expect(groups.map((g) => g.key)).toEqual(["pages"]);
  });

  it("puts records before pages and labels each row", () => {
    const groups = buildGroups("kunden", {
      customers: [
        { id: "c1", name: "Weber GmbH", externalId: "K-1001", type: null, ownerName: null },
      ],
      resources: [
        {
          id: "r1",
          name: "web.example.test",
          externalId: "web.example.test",
          type: "host",
          ownerName: "Weber GmbH",
        },
      ],
      assets: [
        { id: "a1", name: "web HTTP", externalId: "https://web", type: null, ownerName: null },
      ],
    });
    expect(groups.map((g) => g.key)).toEqual(["customers", "resources", "assets", "pages"]);
    expect(groups[0]?.rows[0]).toMatchObject({ kind: "customer", typeLabel: "Kunde" });
    expect(groups[1]?.rows[0]).toMatchObject({ typeLabel: "Host", sublabel: "Weber GmbH" });
    expect(groups[2]?.rows[0]).toMatchObject({ kind: "asset", sublabel: "https://web" });
  });

  it("falls back to the external id when a resource has no owner", () => {
    const groups = buildGroups("zzz", {
      ...EMPTY_PALETTE_DATA,
      resources: [
        {
          id: "r2",
          name: "info@example.de",
          externalId: "info@example.de",
          type: "mailbox",
          ownerName: null,
        },
      ],
    });
    expect(groups[0]?.rows[0]).toMatchObject({
      typeLabel: "Postfach",
      sublabel: "info@example.de",
    });
  });
});

describe("flattenGroups and moveIndex", () => {
  it("walks rows in group order", () => {
    const rows = flattenGroups(buildGroups("kunden", EMPTY_PALETTE_DATA));
    expect(rows.map((r) => r.id)).toEqual(["/customers"]);
  });

  it("wraps around in both directions", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });
});
