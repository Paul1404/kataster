import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { providerCosts } from "../db/schema/costs";
import { resourceSources } from "../db/schema/resource-sources";
import { resources } from "../db/schema/resources";
import { setResourceStatus } from "./history";

// Host CIs are provider-independent: identity is the FQDN, so every source writes
// them under a fixed sentinel provider. Keeps SSM's AWS-ness / hetzner's provider
// out of host identity and lets the existing (provider,type,external_id) unique
// double as the FQDN-uniqueness guarantee.
const HOST_PROVIDER = "other";

/** Normalize an FQDN for identity: trim, lowercase, drop a trailing dot. */
export function normFqdn(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(/\.$/, "");
  return t || null;
}

export interface ReconcileHostInput {
  fqdn?: string | null;
  ips?: (string | null | undefined)[];
  name?: string | null;
  ownerCustomerId?: string | null;
}

// Coalesce owner (never overwrite a hand-set one) and bump lastSeenAt on match.
async function touchCI(id: string, owner: string | null | undefined): Promise<void> {
  await db
    .update(resources)
    .set({
      lastSeenAt: new Date(),
      ownerCustomerId: sql`coalesce(${resources.ownerCustomerId}, ${owner ?? null})`,
    })
    .where(eq(resources.id, id));
}

/**
 * Find-or-create the Host CI for a set of identity hints. FQDN is the canonical
 * key; a shared IP bridges sources that disagree on FQDN (e.g. the Hetzner Cloud
 * label name vs SSM's computerName). At this scale (a handful of hosts) the IP
 * bridge scans host facets in memory. Owner is coalesced so a manual owner sticks.
 */
export async function reconcileHost(input: ReconcileHostInput): Promise<string> {
  const rawFqdn = normFqdn(input.fqdn) ?? (input.name?.includes(".") ? normFqdn(input.name) : null);
  // Only a dotted name is a strong host identity; a bare short hostname (e.g. an
  // EC2/short SSM computerName) is too weak to key a CI on, so fall through to the
  // IP bridge and let a real FQDN or IP establish identity.
  const fqdn = rawFqdn?.includes(".") ? rawFqdn : null;
  const ips = (input.ips ?? []).map((x) => x?.trim()).filter((x): x is string => Boolean(x));

  // 1. Match by FQDN — the canonical host identity.
  if (fqdn) {
    const [row] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.type, "host"), eq(resources.externalId, fqdn)))
      .limit(1);
    if (row) {
      await touchCI(row.id, input.ownerCustomerId);
      return row.id;
    }
  }

  // 2. Bridge by a shared IP against existing host facets.
  if (ips.length > 0) {
    const rows = await db
      .select({ id: resourceSources.resourceId, ips: resourceSources.ips })
      .from(resourceSources)
      .innerJoin(resources, eq(resourceSources.resourceId, resources.id))
      .where(eq(resources.type, "host"));
    const want = new Set(ips);
    const hit = rows.find((r) => (r.ips ?? []).some((ip) => want.has(ip)));
    if (hit) {
      await touchCI(hit.id, input.ownerCustomerId);
      return hit.id;
    }
  }

  // 3. Create. externalId prefers FQDN, then IP, then a dotted name.
  const externalId = fqdn ?? ips[0] ?? input.name?.trim();
  if (!externalId) throw new Error("reconcileHost: no fqdn/ip/name identity provided");
  const [created] = await db
    .insert(resources)
    .values({
      type: "host",
      provider: HOST_PROVIDER,
      externalId,
      name: fqdn ?? input.name?.trim() ?? externalId,
      ownerCustomerId: input.ownerCustomerId ?? null,
    })
    .onConflictDoUpdate({
      target: [resources.provider, resources.type, resources.externalId],
      set: {
        ownerCustomerId: sql`coalesce(${resources.ownerCustomerId}, excluded.owner_customer_id)`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ id: resources.id });
  return created!.id;
}

/**
 * Find-or-create the Domain CI for a domain name. Provider is fixed to 'aws' so
 * the AWS cost pool still splits across domain CIs; any source (Route53, SES,
 * CloudFront, ACM, mailcow) reconciles onto the same CI by name. Owner coalesced.
 */
export async function reconcileDomain(
  name: string,
  ownerCustomerId?: string | null,
): Promise<string | null> {
  // A www subdomain is the same registrable domain CI as its apex, so fold it in.
  const domain = normFqdn(name)?.replace(/^www\./, "");
  if (!domain) return null;
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.type, "domain"), eq(resources.externalId, domain)))
    .limit(1);
  if (row) {
    await touchCI(row.id, ownerCustomerId);
    return row.id;
  }
  const [created] = await db
    .insert(resources)
    .values({
      type: "domain",
      provider: "aws",
      externalId: domain,
      name: domain,
      ownerCustomerId: ownerCustomerId ?? null,
    })
    .onConflictDoUpdate({
      target: [resources.provider, resources.type, resources.externalId],
      set: {
        ownerCustomerId: sql`coalesce(${resources.ownerCustomerId}, excluded.owner_customer_id)`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ id: resources.id });
  return created!.id;
}

/**
 * Sweep CIs and facets no source has confirmed since `cutoff`. Host/Domain CIs are
 * global (no connection scope), so the per-connection pruneStale in sync.ts can't
 * reach them; without this a decommissioned host or a domain removed from Route53
 * would linger forever (still drawing cost / carrying a stale owner). A generous
 * cutoff (days) means a transient failed check can't wipe a live CI. A pruned host's
 * cost pool is deleted with it so it can't degrade into a provider-wide pool via the
 * set-null FK; its children (containers/mailboxes) detach via parentResourceId.
 */
export async function pruneStaleCIs(cutoff: Date): Promise<void> {
  const stale = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        inArray(resources.type, ["host", "domain"]),
        eq(resources.status, "active"),
        lt(resources.lastSeenAt, cutoff),
      ),
    );
  const staleIds = stale.map((r) => r.id);
  if (staleIds.length > 0) {
    // A gone host stops being a cost pool; the CI itself is kept as decommissioned.
    await db.delete(providerCosts).where(inArray(providerCosts.resourceId, staleIds));
    await setResourceStatus({ resourceIds: staleIds, status: "decommissioned", actor: "worker" });
  }
  // Facets whose source stopped reporting, on CIs that otherwise persist.
  await db.delete(resourceSources).where(lt(resourceSources.lastSeenAt, cutoff));
}

/** Upsert one connector's facet onto a CI (its own row; never clobbers others). */
export async function upsertCIFacet(
  resourceId: string,
  source: string,
  data: Record<string, unknown>,
  ips: string[],
  seenAt: Date,
): Promise<void> {
  await db
    .insert(resourceSources)
    .values({ resourceId, source, data, ips, lastSeenAt: seenAt })
    .onConflictDoUpdate({
      target: [resourceSources.resourceId, resourceSources.source],
      set: {
        data: sql`excluded.data`,
        ips: sql`excluded.ips`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });
}
