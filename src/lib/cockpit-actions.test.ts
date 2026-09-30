import { describe, expect, it } from "vitest";
import { buildActionItems, type CockpitAttention } from "./cockpit-actions";

const clean: CockpitAttention = {
  unassignedCount: 0,
  unassignedCostCents: 0,
  unpricedCount: 0,
  uncoveredPoolCount: 0,
  uncoveredPoolCents: 0,
  expiringDomainCount: 0,
  expiringCertCount: 0,
  expiringSoonestDays: null,
  openIncidentCount: 0,
  staleCheckCount: 0,
  workerAlive: true,
};

describe("buildActionItems", () => {
  it("returns nothing when everything is clean", () => {
    expect(buildActionItems(clean)).toEqual([]);
  });

  it("puts a dead worker and open incidents first", () => {
    const items = buildActionItems({
      ...clean,
      workerAlive: false,
      openIncidentCount: 2,
      unassignedCount: 3,
      unassignedCostCents: 1250,
      uncoveredPoolCount: 1,
      uncoveredPoolCents: 500,
    });
    expect(items.map((i) => i.id)).toEqual([
      "worker",
      "incidents",
      "unassigned",
      "uncovered-pools",
    ]);
    expect(items[0]?.severity).toBe("critical");
    expect(items.at(-1)?.severity).toBe("info");
  });

  it("escalates expiries inside 14 days to critical and keeps later ones a warning", () => {
    const soon = buildActionItems({ ...clean, expiringDomainCount: 1, expiringSoonestDays: 3 });
    expect(soon[0]?.severity).toBe("critical");
    const later = buildActionItems({ ...clean, expiringDomainCount: 1, expiringSoonestDays: 40 });
    expect(later[0]?.severity).toBe("warning");
  });

  it("names an overdue renewal instead of counting days", () => {
    const [item] = buildActionItems({
      ...clean,
      expiringCertCount: 2,
      expiringSoonestDays: -1,
    });
    expect(item?.title).toBe("2 Zertifikate laufen bald ab");
    expect(item?.detail).toContain("überfällig");
    expect(item?.link).toEqual({ to: "/objects", search: { type: "acm_cert" } });
  });

  it("uses singular German wording for a single item", () => {
    const [item] = buildActionItems({ ...clean, unassignedCount: 1, unassignedCostCents: 900 });
    expect(item?.title).toBe("1 Objekt ohne Eigentümer");
    expect(item?.detail).toContain("9,00");
    expect(item?.link).toEqual({ to: "/objects", search: { owner: "unassigned", sort: "cost" } });
  });

  it("sends billing gaps to the pages that fix them", () => {
    const items = buildActionItems({
      ...clean,
      unpricedCount: 2,
      staleCheckCount: 4,
      uncoveredPoolCount: 1,
      uncoveredPoolCents: 12_345,
    });
    expect(items.map((i) => i.link.to)).toEqual(["/billing", "/assets", "/costs"]);
  });
});
