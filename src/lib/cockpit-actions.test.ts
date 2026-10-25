import { describe, expect, it } from "vitest";
import { buildActionItems, type CockpitAttention } from "./cockpit-actions";

const clean: CockpitAttention = {
  unassignedCount: 0,
  unassignedCostCents: 0,
  unpricedCount: 0,
  uncoveredPoolCount: 0,
  uncoveredPoolCents: 0,
  incompleteSourceCount: 0,
};
describe("FinOps attention", () => {
  it("has no open work when attribution and source data are complete", () =>
    expect(buildActionItems(clean)).toEqual([]));
  it("takes incomplete financial data and attribution to the pages that fix them", () => {
    const rows = buildActionItems({
      ...clean,
      incompleteSourceCount: 1,
      unassignedCount: 2,
      unassignedCostCents: 1000,
      unpricedCount: 1,
      uncoveredPoolCount: 1,
      uncoveredPoolCents: 500,
    });
    expect(rows.map((r) => r.link.to)).toEqual(["/sources", "/objects", "/billing", "/costs"]);
    expect(rows.map((r) => r.id)).not.toContain("incidents");
    expect(rows[1]?.detail).toContain("10,00");
  });
});
