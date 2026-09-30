// Pure grouping for the Kostenverteilung list on /costs. Tested in
// cost-allocation-groups.test.ts.

export interface AllocationResource {
  id: string;
  name: string;
  type: string;
  provider: string;
  ownerName: string | null;
}
export interface AllocationEntry {
  id: string;
  resourceId: string;
  mode: "fixed" | "weighted";
  amountCents: number | null;
  weight: number | null;
  providerCostId: string | null;
  auto: boolean;
  cents: number;
}
export interface AllocationPool {
  id: string;
  provider: string;
  displayLabel: string;
  amountCents: number;
}

/**
 * How a resource draws cost, as the operator sees it:
 *  - auto: the auto-allocator decides (an auto row, or no row yet)
 *  - fixed: a hand-set monthly amount
 *  - zero: excluded by hand (a manual fixed 0 €, which the allocator respects;
 *    deleting the row would only hand it back to the allocator)
 *  - weighted: a hand-set weight on a chosen pool
 */
export type RowMode = "auto" | "fixed" | "zero" | "weighted";

export function rowMode(alloc: AllocationEntry | null): RowMode {
  if (!alloc || alloc.auto) return "auto";
  if (alloc.mode === "weighted") return "weighted";
  return (alloc.amountCents ?? 0) > 0 ? "fixed" : "zero";
}

export interface AllocationRowView {
  resource: AllocationResource;
  alloc: AllocationEntry | null;
  mode: RowMode;
  cents: number;
}
export interface AllocationGroup {
  key: string;
  /** The pool the rows draw from; null for the fixed and no-cost groups. */
  pool: AllocationPool | null;
  title: string;
  rows: AllocationRowView[];
  cents: number;
}

const PROVIDER_ORDER = ["aws", "hetzner", "railway", "mailcow", "other"];

/**
 * One group per pool (in provider order, then by amount), then "Feste Beträge"
 * and "Ohne Kosten" last. Rows inside a group sort by amount, then name.
 */
export function groupAllocations(input: {
  resources: AllocationResource[];
  allocations: AllocationEntry[];
  pools: AllocationPool[];
}): AllocationGroup[] {
  const allocByResource = new Map(input.allocations.map((a) => [a.resourceId, a]));
  const poolById = new Map(input.pools.map((p) => [p.id, p]));
  const byKey = new Map<string, AllocationGroup>();
  const group = (key: string, pool: AllocationPool | null, title: string) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, pool, title, rows: [], cents: 0 };
      byKey.set(key, g);
    }
    return g;
  };

  for (const resource of input.resources) {
    const alloc = allocByResource.get(resource.id) ?? null;
    const cents = alloc?.cents ?? 0;
    const pool =
      alloc?.mode === "weighted" && alloc.providerCostId
        ? poolById.get(alloc.providerCostId)
        : undefined;
    const g = pool
      ? group(`pool:${pool.id}`, pool, pool.displayLabel)
      : cents > 0
        ? group("fixed", null, "Feste Beträge")
        : group("none", null, "Ohne Kosten");
    g.rows.push({ resource, alloc, mode: rowMode(alloc), cents });
    g.cents += cents;
  }

  const rank = (g: AllocationGroup) => (g.key === "none" ? 2 : g.key === "fixed" ? 1 : 0);
  const providerRank = (g: AllocationGroup) => {
    const i = PROVIDER_ORDER.indexOf(g.pool?.provider ?? "");
    return i === -1 ? PROVIDER_ORDER.length : i;
  };
  const groups = [...byKey.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      providerRank(a) - providerRank(b) ||
      b.cents - a.cents ||
      a.title.localeCompare(b.title, "de"),
  );
  for (const g of groups) {
    g.rows.sort(
      (a, b) => b.cents - a.cents || a.resource.name.localeCompare(b.resource.name, "de"),
    );
  }
  return groups;
}
