import { describe, expect, it } from "vitest";
import { type AllocationEntry, groupAllocations, rowMode } from "./cost-allocation-groups";

const alloc = (over: Partial<AllocationEntry>): AllocationEntry => ({
  id: "a",
  resourceId: "r",
  mode: "weighted",
  amountCents: null,
  weight: 1,
  providerCostId: "p",
  auto: true,
  cents: 0,
  ...over,
});
const res = (id: string, name = id) => ({
  id,
  name,
  type: "mailbox",
  provider: "mailcow",
  ownerName: null,
});

describe("rowMode", () => {
  it("treats no row and auto rows as automatic", () => {
    expect(rowMode(null)).toBe("auto");
    expect(rowMode(alloc({ auto: true }))).toBe("auto");
  });

  it("tells a manual zero apart from a fixed amount", () => {
    expect(rowMode(alloc({ auto: false, mode: "fixed", amountCents: 0 }))).toBe("zero");
    expect(rowMode(alloc({ auto: false, mode: "fixed", amountCents: 500 }))).toBe("fixed");
    expect(rowMode(alloc({ auto: false, mode: "weighted" }))).toBe("weighted");
  });
});

describe("groupAllocations", () => {
  it("groups by pool, then fixed amounts, then resources without cost", () => {
    const groups = groupAllocations({
      resources: [res("a"), res("b"), res("c"), res("d")],
      pools: [
        { id: "small", provider: "aws", displayLabel: "AWS", amountCents: 100 },
        { id: "mail", provider: "hetzner", displayLabel: "mail.example.test", amountCents: 1010 },
      ],
      allocations: [
        alloc({ id: "1", resourceId: "a", providerCostId: "mail", cents: 600 }),
        alloc({ id: "2", resourceId: "b", providerCostId: "small", cents: 100 }),
        alloc({
          id: "3",
          resourceId: "c",
          mode: "fixed",
          amountCents: 250,
          auto: false,
          cents: 250,
        }),
      ],
    });
    expect(groups.map((g) => g.title)).toEqual([
      "AWS",
      "mail.example.test",
      "Feste Beträge",
      "Ohne Kosten",
    ]);
    expect(groups.map((g) => g.cents)).toEqual([100, 600, 250, 0]);
    expect(groups.at(-1)!.rows[0]!.resource.id).toBe("d");
  });

  it("sorts rows by amount, then name", () => {
    const [g] = groupAllocations({
      resources: [res("x", "Zeta"), res("y", "Alpha"), res("z", "Beta")],
      pools: [{ id: "p", provider: "railway", displayLabel: "lfio", amountCents: 300 }],
      allocations: [
        alloc({ id: "1", resourceId: "x", cents: 200 }),
        alloc({ id: "2", resourceId: "y", cents: 50 }),
        alloc({ id: "3", resourceId: "z", cents: 50 }),
      ],
    });
    expect(g!.rows.map((r) => r.resource.name)).toEqual(["Zeta", "Alpha", "Beta"]);
  });
});
