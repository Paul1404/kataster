import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../db";
import { providerCosts } from "../db/schema/costs";
import { resources } from "../db/schema/resources";
import { toEurCents } from "./fx";

export const AWS_COST_LABEL = "AWS account (auto)";
export const AWS_COST_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Cost Explorer charges per request and its source data normally refreshes daily.
 * Keep this decision independent of the asset's much faster monitoring cadence.
 */
export function isAwsCostRefreshDue(lastUpdatedAt: Date | null, now: Date): boolean {
  if (!lastUpdatedAt) return true;
  return now.getTime() - lastUpdatedAt.getTime() >= AWS_COST_REFRESH_INTERVAL_MS;
}

export async function shouldRefreshAwsCost(now: Date): Promise<boolean> {
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [existing] = await db
    .select({ updatedAt: providerCosts.updatedAt })
    .from(providerCosts)
    .where(
      and(
        eq(providerCosts.provider, "aws"),
        eq(providerCosts.period, period),
        eq(providerCosts.label, AWS_COST_LABEL),
      ),
    )
    .limit(1);

  return isAwsCostRefreshDue(existing?.updatedAt ?? null, now);
}

// Upsert a metered AWS cost pool from a check's Cost Explorer block. Keyed by the
// fixed label so it refreshes in place once daily; the operator allocates it on
// the margin page (CE gives the account total, not per-customer). Cost Explorer
// reports USD, converted to EUR (the app's single reporting currency) at ingest.
export async function ingestAwsCost(raw: Record<string, unknown>): Promise<void> {
  const cost = raw.cost as
    | {
        amountCents?: number;
        currency?: string;
        period?: string;
        byService?: Record<string, number>;
      }
    | undefined;
  if (!cost || typeof cost.amountCents !== "number" || !cost.period) return;
  const currency = cost.currency ?? "USD";

  // Split the DNS services out onto the domains that cause them, so a customer's
  // DNS cost is visible instead of averaged across every AWS resource. What is
  // left over stays the account-wide pool, so the money still reconciles.
  const dnsCents = await ingestAwsDnsCost(raw, cost.period, cost.byService ?? {}, currency);
  const eurCents = Math.max(0, toEurCents(cost.amountCents, currency) - dnsCents);
  await db
    .insert(providerCosts)
    .values({
      provider: "aws",
      period: cost.period,
      label: AWS_COST_LABEL,
      source: "metered",
      amountCents: eurCents,
      currency: "EUR",
    })
    .onConflictDoUpdate({
      target: [providerCosts.provider, providerCosts.period, providerCosts.label],
      set: {
        amountCents: eurCents,
        currency: "EUR",
        source: "metered",
        updatedAt: new Date(),
      },
    });
}

export const AWS_DNS_LABEL_PREFIX = "Route 53";

/** A zone as the AWS connector reports it, reduced to what cost attribution needs. */
export interface DnsZoneShape {
  name: string;
  private?: boolean;
  dnssecEnabled?: boolean | null;
}

/**
 * Pure: split the two DNS line items across the zones that cause them.
 *  - Route 53 (hosted zone + query charges) splits evenly across public zones:
 *    every zone carries the same flat monthly hosted-zone fee.
 *  - KMS is the DNSSEC key signing keys, one per signed zone, so it splits evenly
 *    across the signed zones only.
 * Uses the period's actual charges rather than list prices, so a part-month or a
 * price change stays correct and the parts always add back up to the bill.
 */
export function splitDnsCost(input: {
  zones: DnsZoneShape[];
  route53Cents: number;
  kmsCents: number;
}): { zone: string; cents: number }[] {
  const publicZones = input.zones.filter((z) => !z.private);
  if (publicZones.length === 0) return [];
  const signed = publicZones.filter((z) => z.dnssecEnabled === true);
  const perZone = input.route53Cents / publicZones.length;
  const perSigned = signed.length > 0 ? input.kmsCents / signed.length : 0;

  // Round with largest remainder, not per row: rounding each share on its own
  // drifts by a cent or two and the pools stop adding up to the bill, which is
  // exactly the kind of quiet gap this split exists to close.
  const exact = publicZones.map((z) => ({
    zone: z.name.replace(/\.$/, "").toLowerCase(),
    value: perZone + (z.dnssecEnabled === true ? perSigned : 0),
  }));
  const target = Math.round(input.route53Cents + (signed.length > 0 ? input.kmsCents : 0));
  const rows = exact.map((e) => ({ zone: e.zone, cents: Math.floor(e.value), rest: e.value % 1 }));
  let left = target - rows.reduce((a, b) => a + b.cents, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    r.cents += 1;
    left -= 1;
  }
  return rows.map(({ zone, cents }) => ({ zone, cents })).filter((r) => r.cents > 0);
}

/**
 * Upsert one cost pool per DNS zone, scoped to that zone's Domain CI so the
 * allocator charges it to the domain's owner. Returns the EUR cents moved out of
 * the account pool. Zones with no Domain CI are left in the account pool rather
 * than invented as orphan pools.
 */
async function ingestAwsDnsCost(
  raw: Record<string, unknown>,
  period: string,
  byService: Record<string, number>,
  currency: string,
): Promise<number> {
  const block = raw.zones as { list?: DnsZoneShape[] } | undefined;
  const zones = block?.list;
  if (!Array.isArray(zones) || zones.length === 0) return 0;

  const parts = splitDnsCost({
    zones,
    route53Cents: byService["Amazon Route 53"] ?? 0,
    kmsCents: byService["AWS Key Management Service"] ?? 0,
  });
  if (parts.length === 0) return 0;

  const domainRows = await db
    .select({ id: resources.id, externalId: resources.externalId })
    .from(resources)
    .where(eq(resources.type, "domain"));
  const domainByName = new Map(domainRows.map((d) => [d.externalId.toLowerCase(), d.id]));

  const keptLabels: string[] = [];
  let movedEurCents = 0;
  for (const part of parts) {
    const resourceId = domainByName.get(part.zone);
    if (!resourceId) continue;
    const eurCents = toEurCents(part.cents, currency);
    if (eurCents <= 0) continue;
    const label = `${AWS_DNS_LABEL_PREFIX} ${part.zone}`;
    keptLabels.push(label);
    movedEurCents += eurCents;
    await db
      .insert(providerCosts)
      .values({
        provider: "aws",
        period,
        label,
        resourceId,
        source: "metered",
        amountCents: eurCents,
        currency: "EUR",
      })
      .onConflictDoUpdate({
        target: [providerCosts.provider, providerCosts.period, providerCosts.label],
        set: { amountCents: eurCents, resourceId, source: "metered", updatedAt: new Date() },
      });
  }

  // Drop this period's DNS pools for zones that are gone (zone deleted or its
  // Domain CI retired), so a removed zone stops inflating its owner's cost.
  const stale = await db
    .select({ id: providerCosts.id, label: providerCosts.label })
    .from(providerCosts)
    .where(
      and(
        eq(providerCosts.provider, "aws"),
        eq(providerCosts.period, period),
        eq(providerCosts.source, "metered"),
        isNotNull(providerCosts.resourceId),
      ),
    );
  const drop = stale
    .filter((p) => p.label.startsWith(`${AWS_DNS_LABEL_PREFIX} `) && !keptLabels.includes(p.label))
    .map((p) => p.id);
  if (drop.length > 0) {
    await db.delete(providerCosts).where(inArray(providerCosts.id, drop));
  }
  return movedEurCents;
}

// Upsert per-project Railway cost pools from a check's estimated-cost block. Each
// project becomes a resource-scoped pool (resourceId = the railway_project CI), so
// the allocator splits it across that project's services automatically. Stale
// per-project pools (project removed) are pruned. Manual ('fixed') pools untouched.
export async function ingestRailwayCost(raw: Record<string, unknown>): Promise<void> {
  const cost = raw.cost as
    | {
        period?: string;
        currency?: string;
        projects?: { projectId: string; amountCents: number }[];
      }
    | undefined;
  if (!cost?.period || !Array.isArray(cost.projects)) return;
  const srcCurrency = cost.currency ?? "USD";

  // Map Railway project id -> its CI resource id (external_id holds the project id).
  const projRows = await db
    .select({ id: resources.id, externalId: resources.externalId })
    .from(resources)
    .where(and(eq(resources.provider, "railway"), eq(resources.type, "railway_project")));
  const idByExt = new Map(projRows.map((r) => [r.externalId, r.id]));

  const seen = new Set<string>();
  for (const p of cost.projects) {
    const resourceId = idByExt.get(p.projectId);
    if (!resourceId || typeof p.amountCents !== "number") continue;
    seen.add(resourceId);
    // Railway prices in USD; store EUR (the app's single reporting currency).
    const eurCents = toEurCents(p.amountCents, srcCurrency);
    await db
      .insert(providerCosts)
      .values({
        provider: "railway",
        period: cost.period,
        // Stable, readable pool label keyed to the project CI.
        label: `railway:${p.projectId}`,
        resourceId,
        source: "metered",
        amountCents: eurCents,
        currency: "EUR",
      })
      .onConflictDoUpdate({
        target: [providerCosts.provider, providerCosts.period, providerCosts.label],
        set: { amountCents: eurCents, resourceId, currency: "EUR", source: "metered" },
      });
  }

  // Prune this period's metered Railway pools whose project is gone from the
  // account (or all of them if nothing priced this cycle). Manual pools untouched.
  const pruneWhere = [
    eq(providerCosts.provider, "railway"),
    eq(providerCosts.period, cost.period),
    eq(providerCosts.source, "metered"),
    isNotNull(providerCosts.resourceId),
  ];
  if (seen.size > 0) pruneWhere.push(notInArray(providerCosts.resourceId, [...seen]));
  await db.delete(providerCosts).where(and(...pruneWhere));
}
