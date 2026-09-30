import { describe, expect, it } from "vitest";
import { periodOf, resolveAllocationCents, resolveAllocationsCents, rollupMargin } from "./margin";

describe("resolveAllocationCents", () => {
  const pools = new Map([["pool-box", 6000]]); // €60 box

  it("returns a fixed amount directly", () => {
    expect(
      resolveAllocationCents(
        { resourceId: "r", mode: "fixed", amountCents: 1500, weight: null, providerCostId: null },
        pools,
      ),
    ).toBe(1500);
  });

  it("computes a weighted share of a pool, rounded to cents", () => {
    expect(
      resolveAllocationCents(
        {
          resourceId: "r",
          mode: "weighted",
          amountCents: null,
          weight: 0.25,
          providerCostId: "pool-box",
        },
        pools,
      ),
    ).toBe(1500);
  });

  it("is zero when a weighted allocation points at a missing pool", () => {
    expect(
      resolveAllocationCents(
        {
          resourceId: "r",
          mode: "weighted",
          amountCents: null,
          weight: 0.5,
          providerCostId: "gone",
        },
        pools,
      ),
    ).toBe(0);
  });
});

describe("resolveAllocationsCents", () => {
  const share = (resourceId: string, weight: number, providerCostId = "pool") => ({
    resourceId,
    mode: "weighted" as const,
    amountCents: null,
    weight,
    providerCostId,
  });

  it("distributes a pool exactly, never a cent more or less", () => {
    // 46 even shares of 10,10 € rounded one by one come to 10,12 €.
    const allocs = Array.from({ length: 46 }, (_, i) => share(`mb${i}`, 1 / 46));
    const out = resolveAllocationsCents(allocs, [{ id: "pool", amountCents: 1010 }]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1010);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThanOrEqual(1);
  });

  it("keeps fixed amounts and input order, and ignores missing pools", () => {
    const out = resolveAllocationsCents(
      [
        { resourceId: "f", mode: "fixed", amountCents: 500, weight: null, providerCostId: null },
        share("a", 0.5),
        share("gone", 1, "missing"),
        share("b", 0.5),
      ],
      [{ id: "pool", amountCents: 3 }],
    );
    expect(out).toEqual([500, 2, 0, 1]);
  });
});

describe("rollupMargin", () => {
  it("rolls cost up per owner, applies pricing, and splits out unallocated overhead", () => {
    const summary = rollupMargin({
      customers: [
        { id: "c-weng", name: "Wengertsberg" },
        { id: "c-svu", name: "SVU" },
      ],
      resourceOwner: new Map([
        ["r-weng-wp", "c-weng"],
        ["r-svu-wp", "c-svu"],
        ["r-internal", null], // owned by nobody -> overhead
      ]),
      pools: [{ id: "pool-box", amountCents: 6000 }],
      allocations: [
        // Wengertsberg: a fixed €15 hosting price
        {
          resourceId: "r-weng-wp",
          mode: "fixed",
          amountCents: 1500,
          weight: null,
          providerCostId: null,
        },
        // SVU: a 0.25 weighted share of the €60 box = €15
        {
          resourceId: "r-svu-wp",
          mode: "weighted",
          amountCents: null,
          weight: 0.25,
          providerCostId: "pool-box",
        },
        // internal container: 0.5 of the box = €30 overhead
        {
          resourceId: "r-internal",
          mode: "weighted",
          amountCents: null,
          weight: 0.5,
          providerCostId: "pool-box",
        },
      ],
      pricing: [
        { customerId: "c-weng", amountCents: 4000 }, // charge €40
        { customerId: "c-svu", amountCents: 1000 }, // charge €10 (loss)
      ],
    });

    const weng = summary.rows.find((r) => r.customerId === "c-weng")!;
    expect(weng.costCents).toBe(1500);
    expect(weng.marginCents).toBe(2500); // 4000 - 1500

    const svu = summary.rows.find((r) => r.customerId === "c-svu")!;
    expect(svu.costCents).toBe(1500);
    expect(svu.marginCents).toBe(-500); // 1000 - 1500, a loss

    expect(summary.unallocatedCostCents).toBe(3000);
    expect(summary.totalCostCents).toBe(6000);
    expect(summary.totalChargeCents).toBe(5000);
    expect(summary.totalMarginCents).toBe(-1000);
  });
});

describe("periodOf", () => {
  it("formats YYYY-MM in UTC", () => {
    expect(periodOf(new Date("2026-06-30T23:00:00Z"))).toBe("2026-06");
    expect(periodOf(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01");
  });
});
