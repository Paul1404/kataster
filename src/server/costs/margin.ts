// Pure cost allocation + margin rollup. No DB access -- the router feeds it rows.

export interface AllocationInput {
  resourceId: string;
  mode: "fixed" | "weighted";
  amountCents: number | null;
  weight: number | null;
  providerCostId: string | null;
}
export interface PoolInput {
  id: string;
  amountCents: number;
}

/** Resolve one allocation to monthly cents: a fixed amount, or weight * pool. */
export function resolveAllocationCents(
  alloc: AllocationInput,
  poolById: Map<string, number>,
): number {
  if (alloc.mode === "fixed") {
    return Math.max(0, Math.round(alloc.amountCents ?? 0));
  }
  if (alloc.mode === "weighted" && alloc.providerCostId != null && alloc.weight != null) {
    const pool = poolById.get(alloc.providerCostId);
    if (pool == null) return 0;
    return Math.max(0, Math.round(alloc.weight * pool));
  }
  return 0;
}

/**
 * Resolve every allocation of a period to cents, aligned with the input order.
 * Weighted shares are rounded per pool by largest remainder, not per row: rounding
 * 46 mailbox shares of a 10,10 € pool one by one gave 10,12 €, so the page showed
 * more cost allocated than was paid. Here the shares of a pool always add up to
 * round(sum of exact shares), which is the whole pool when the weights sum to 1.
 */
export function resolveAllocationsCents(
  allocations: AllocationInput[],
  pools: PoolInput[],
): number[] {
  const poolById = new Map(pools.map((p) => [p.id, p.amountCents]));
  const out = allocations.map((a) =>
    a.mode === "fixed" ? resolveAllocationCents(a, poolById) : 0,
  );
  const byPool = new Map<string, { index: number; exact: number }[]>();
  allocations.forEach((a, index) => {
    if (a.mode !== "weighted" || a.providerCostId == null || a.weight == null) return;
    const pool = poolById.get(a.providerCostId);
    if (pool == null) return;
    const exact = Math.max(0, a.weight * pool);
    const list = byPool.get(a.providerCostId);
    if (list) list.push({ index, exact });
    else byPool.set(a.providerCostId, [{ index, exact }]);
  });
  for (const shares of byPool.values()) {
    const target = Math.round(shares.reduce((s, x) => s + x.exact, 0));
    for (const x of shares) out[x.index] = Math.floor(x.exact);
    let left = target - shares.reduce((s, x) => s + out[x.index]!, 0);
    const byRest = [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.index - b.index);
    for (const x of byRest) {
      if (left <= 0) break;
      out[x.index]! += 1;
      left -= 1;
    }
  }
  return out;
}

export interface MarginRow {
  customerId: string;
  name: string;
  costCents: number;
  chargeCents: number;
  marginCents: number;
}
export interface MarginSummary {
  rows: MarginRow[];
  /** Resolved cost of resources owned by nobody -- overhead, not attributed. */
  unallocatedCostCents: number;
  totalCostCents: number;
  totalChargeCents: number;
  totalMarginCents: number;
}

/**
 * Roll allocations up to per-customer cost, join against pricing, and compute
 * margin. Costs of resources with no owner land in unallocatedCostCents.
 */
export function rollupMargin(input: {
  customers: { id: string; name: string }[];
  resourceOwner: Map<string, string | null>;
  allocations: AllocationInput[];
  pools: PoolInput[];
  pricing: { customerId: string; amountCents: number }[];
}): MarginSummary {
  const resolved = resolveAllocationsCents(input.allocations, input.pools);
  const costByCustomer = new Map<string, number>();
  let unallocatedCostCents = 0;
  let totalCostCents = 0;

  for (const [i, alloc] of input.allocations.entries()) {
    const cents = resolved[i]!;
    if (cents === 0) continue;
    totalCostCents += cents;
    const owner = input.resourceOwner.get(alloc.resourceId) ?? null;
    if (owner == null) {
      unallocatedCostCents += cents;
      continue;
    }
    costByCustomer.set(owner, (costByCustomer.get(owner) ?? 0) + cents);
  }

  const chargeByCustomer = new Map(input.pricing.map((p) => [p.customerId, p.amountCents]));
  const rows: MarginRow[] = input.customers.map((c) => {
    const costCents = costByCustomer.get(c.id) ?? 0;
    const chargeCents = chargeByCustomer.get(c.id) ?? 0;
    return {
      customerId: c.id,
      name: c.name,
      costCents,
      chargeCents,
      marginCents: chargeCents - costCents,
    };
  });

  const totalChargeCents = rows.reduce((s, r) => s + r.chargeCents, 0);
  return {
    rows,
    unallocatedCostCents,
    totalCostCents,
    totalChargeCents,
    totalMarginCents: totalChargeCents - totalCostCents,
  };
}

/** Pure: the 'YYYY-MM' period for a date (UTC). */
export function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
