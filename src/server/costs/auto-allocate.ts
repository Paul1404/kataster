import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { costAllocations, providerCosts } from "../db/schema/costs";
import { resources } from "../db/schema/resources";

// Leaf resource types that draw cost. Aggregate/parent resources are excluded so
// the pool is not double-counted: a `host`/`vps` IS the thing the Hetzner pool
// pays for, and a `railway_project` merely holds the billable services.
const EXCLUDED_TYPES = new Set(["host", "vps", "railway_project"]);

export interface AutoResource {
  id: string;
  provider: string;
  type: string;
  parentResourceId: string | null;
  /** Usage signal (bytes of RAM, CPU%, …); 0 means "no signal, use even split". */
  weight: number;
}
export interface AutoPool {
  id: string;
  provider: string;
  /** When set, a host-scoped pool: split only across this host's children. */
  resourceId: string | null;
}
export interface DesiredAlloc {
  resourceId: string;
  providerCostId: string;
  weight: number;
}

// Split a pool across a set of resources by usage weight, normalized so the whole
// pool is distributed. A resource with no usage signal gets its peers' average, so
// it never falls to zero.
function allocate(rs: AutoResource[], pool: AutoPool, out: DesiredAlloc[]): void {
  if (rs.length === 0) return;
  const present = rs.filter((r) => r.weight > 0);
  const avg = present.length > 0 ? present.reduce((s, r) => s + r.weight, 0) / present.length : 1;
  const eff = rs.map((r) => (r.weight > 0 ? r.weight : avg));
  const total = eff.reduce((s, w) => s + w, 0);
  rs.forEach((r, i) => {
    out.push({
      resourceId: r.id,
      providerCostId: pool.id,
      weight: total > 0 ? eff[i]! / total : 1 / rs.length,
    });
  });
}

/** Usage weight for a resource: a container's RAM footprint (stable, what a box is
 * sized for), falling back to CPU, then to 0 (even split). Non-container leaf
 * resources have no per-resource usage signal, so they split evenly (weight 1). */
export function resourceWeight(type: string, metadata: Record<string, unknown>): number {
  if (type === "container") {
    const mem = metadata.memBytes;
    if (typeof mem === "number" && mem > 0) return mem;
    const cpu = metadata.cpuPercent;
    if (typeof cpu === "number" && cpu > 0) return cpu;
    return 0;
  }
  return 1;
}

/**
 * Pure: turn cost pools + inventory into per-resource weighted allocations.
 *  - A pool scoped to a leaf resource (e.g. a Route 53 zone pool on its Domain
 *    CI) lands entirely on that resource.
 *  - Host-scoped pools (pool.resourceId set, e.g. a Hetzner box invoice) split
 *    across the host's "served" resources: its containers by RAM (a web host),
 *    else a caller-supplied set (e.g. mailboxes for a mail host), else the host
 *    itself so a serves-nobody box (a monitoring box) falls to its owner. The
 *    served-set is passed in `hostServed`; without it, containers are the default.
 *  - Provider-scoped pools (resourceId null, e.g. the AWS account total) split
 *    across that provider's leaf resources not already claimed by a host pool;
 *    one pool per provider (first by input order wins).
 * Weights within a pool are normalized so the whole pool is distributed, and
 * every resource appears at most once in the result.
 */
export function computeAutoAllocations(input: {
  pools: AutoPool[];
  resources: AutoResource[];
  hostServed?: Map<string, AutoResource[]>;
}): DesiredAlloc[] {
  const out: DesiredAlloc[] = [];
  const claimed = new Set<string>();
  const hostServed = input.hostServed ?? new Map<string, AutoResource[]>();

  const byId = new Map(input.resources.map((r) => [r.id, r]));

  // Resource-scoped pools first. A pool scoped to a leaf (a Route 53 zone pool on
  // its Domain CI) is that resource's own cost and lands on it. A pool scoped to an
  // aggregate (a host, a Railway project) splits across what it serves or holds.
  // A resource draws from at most one pool per period (cost_allocations is unique
  // per resource and period), so a resource already claimed is never offered to a
  // later pool: without that, a domain's zone pool and the mail host's pool both
  // claimed the domain's mailboxes and the whole upsert failed.
  for (const pool of input.pools) {
    if (!pool.resourceId) continue;
    const scoped = byId.get(pool.resourceId);
    const rs = (
      scoped && !EXCLUDED_TYPES.has(scoped.type)
        ? [scoped]
        : (hostServed.get(pool.resourceId) ??
          input.resources.filter(
            (r) => r.parentResourceId === pool.resourceId && !EXCLUDED_TYPES.has(r.type),
          ))
    ).filter((r) => !claimed.has(r.id));
    allocate(rs, pool, out);
    for (const r of rs) claimed.add(r.id);
  }

  // Provider-scoped pools: one per provider, split across that provider's leaves
  // not already claimed by a host pool.
  const poolByProvider = new Map<string, AutoPool>();
  for (const p of input.pools) {
    if (p.resourceId) continue;
    if (!poolByProvider.has(p.provider)) poolByProvider.set(p.provider, p);
  }
  const byProvider = new Map<string, AutoResource[]>();
  for (const r of input.resources) {
    if (EXCLUDED_TYPES.has(r.type) || claimed.has(r.id) || !poolByProvider.has(r.provider))
      continue;
    const list = byProvider.get(r.provider);
    if (list) list.push(r);
    else byProvider.set(r.provider, [r]);
  }
  for (const [provider, rs] of byProvider) {
    allocate(rs, poolByProvider.get(provider)!, out);
  }
  return out;
}

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Regenerate usage-weighted auto-allocations for a period from the current pools
 * and inventory. Resources with a manual allocation are left untouched (manual
 * wins); auto allocations for resources that no longer qualify are pruned. Runs
 * automatically after a cost-relevant provider re-syncs, inside a per-period
 * advisory-locked transaction so overlapping worker runs can't delete each other's
 * freshly-inserted rows.
 */
export async function refreshAutoAllocations(period: string): Promise<void> {
  await db.transaction((tx) => refreshAllocationsInTx(tx, period));
}

async function refreshAllocationsInTx(db: Tx, period: string): Promise<void> {
  // Non-blocking: if another refresh for this period holds the lock, skip — its
  // run covers this period, and skipping avoids holding a pool connection in a
  // queue. Data stays consistent because every check triggers a refresh.
  const locked = (
    await db.execute(sql`select pg_try_advisory_xact_lock(hashtext(${period})) as ok`)
  ).rows as { ok: boolean }[];
  if (!locked[0]?.ok) return;

  // Sequential on purpose: these run on the transaction's single connection, and
  // pg deprecates (pg@9 rejects) issuing a query while another is in flight on
  // the same client. Promise.all here only queued them anyway.
  const pools = await db
    .select({
      id: providerCosts.id,
      provider: providerCosts.provider,
      resourceId: providerCosts.resourceId,
    })
    .from(providerCosts)
    .where(eq(providerCosts.period, period));
  const resourceRows = await db
    .select({
      id: resources.id,
      provider: resources.provider,
      type: resources.type,
      parentResourceId: resources.parentResourceId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(eq(resources.status, "active"));
  const existing = await db
    .select({ resourceId: costAllocations.resourceId, auto: costAllocations.auto })
    .from(costAllocations)
    .where(eq(costAllocations.period, period));

  // Resources the operator allocated by hand are off-limits to the auto-allocator.
  const manual = new Set(existing.filter((a) => !a.auto).map((a) => a.resourceId));
  const autoResources: AutoResource[] = resourceRows
    .filter((r) => !manual.has(r.id))
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      type: r.type,
      parentResourceId: r.parentResourceId,
      weight: resourceWeight(r.type, r.metadata),
    }));

  // Decide what each host pool's cost splits across (see computeAutoAllocations):
  // its containers (web host); else its mailboxes if it's the mailcow server (mail
  // host -> the cost falls on the mail customers); else the host itself, so an
  // infra box that serves no customer (a monitoring box) falls to its owner, which
  // for an internal-owned box lands in overhead.
  const mailHostIds = new Set(
    (
      await db.execute(sql`
        select distinct r.id from resources r
        join assets a on a.connector_id = 'mailcow' and lower(a.target) = r.external_id
        where r.type = 'host'
      `)
    ).rows.map((x) => (x as { id: string }).id),
  );
  const byId = new Map(autoResources.map((r) => [r.id, r]));
  const mailboxes = autoResources.filter((r) => r.type === "mailbox");
  const hostServed = new Map<string, AutoResource[]>();
  for (const pool of pools) {
    if (!pool.resourceId) continue;
    const hostId = pool.resourceId;
    // The container/mailbox/self served-set logic is specific to host CIs (a
    // Hetzner box). Other resource-scoped pools (e.g. a Railway project) are left
    // out of hostServed so computeAutoAllocations splits them across their own
    // children (the project's services) via its default rule. Without this guard
    // a project pool would fall to the "serves nobody -> self" branch and land on
    // the project resource, which has no owner, instead of on its services.
    if (byId.get(hostId)?.type !== "host") continue;
    const containers = autoResources.filter(
      (r) => r.parentResourceId === hostId && r.type === "container",
    );
    if (containers.length > 0) hostServed.set(hostId, containers);
    else if (mailHostIds.has(hostId) && mailboxes.length > 0) hostServed.set(hostId, mailboxes);
    else {
      const self = byId.get(hostId);
      hostServed.set(hostId, self ? [self] : []);
    }
  }

  const desired = computeAutoAllocations({ pools, resources: autoResources, hostServed });

  if (desired.length > 0) {
    await db
      .insert(costAllocations)
      .values(
        desired.map((d) => ({
          resourceId: d.resourceId,
          period,
          mode: "weighted" as const,
          weight: d.weight,
          amountCents: null,
          providerCostId: d.providerCostId,
          auto: true,
        })),
      )
      .onConflictDoUpdate({
        target: [costAllocations.resourceId, costAllocations.period],
        set: {
          mode: sql`excluded.mode`,
          weight: sql`excluded.weight`,
          amountCents: sql`excluded.amount_cents`,
          providerCostId: sql`excluded.provider_cost_id`,
          auto: sql`excluded.auto`,
        },
      });
  }

  // Prune auto allocations whose resource no longer qualifies (pool gone, resource
  // deleted, or newly manual). Never touches manual rows.
  const keep = new Set(desired.map((d) => d.resourceId));
  const stale = existing.filter((a) => a.auto && !keep.has(a.resourceId)).map((a) => a.resourceId);
  if (stale.length > 0) {
    await db
      .delete(costAllocations)
      .where(
        and(
          eq(costAllocations.period, period),
          eq(costAllocations.auto, true),
          inArray(costAllocations.resourceId, stale),
        ),
      );
  }
}
