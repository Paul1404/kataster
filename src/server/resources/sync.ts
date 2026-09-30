import { and, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { periodOf } from "../costs/margin";
import { db } from "../db";
import { domains, webDistributions } from "../db/schema/aws";
import { certificates } from "../db/schema/certs";
import { providerCosts } from "../db/schema/costs";
import { customers } from "../db/schema/customers";
import { mailboxes, mailDomains } from "../db/schema/mail";
import { resources } from "../db/schema/resources";
import { reconcileDomain, reconcileHost, upsertCIFacet } from "./ci";
import { setResourceStatus } from "./history";
import {
  awsTenantSeeds,
  mailboxResourceSeeds,
  type ResourceProviderValue,
  type ResourceSeed,
  type ResourceTypeValue,
  railwayResourceSeeds,
} from "./map";

// Resources mirror the per-asset typed inventory (already synced + pruned by the
// connector reconcilers), projected onto one unified, per-customer-owned table.
// Pruning is scoped to the asset's connection: one asset uses one connection per
// provider here, so unseen rows for that connection are genuinely gone.
interface AssetRef {
  id: string;
  connectionId: string | null;
  target?: string;
}

async function upsertSeeds(
  seeds: ResourceSeed[],
  provider: ResourceProviderValue,
  connectionId: string,
  seenAt: Date,
): Promise<void> {
  const toRow = (s: ResourceSeed) => ({
    type: s.type,
    provider,
    externalId: s.externalId,
    name: s.name,
    ownerCustomerId: s.ownerCustomerId,
    connectionId,
    metadata: s.metadata,
    lastSeenAt: seenAt,
    status: "active" as const,
  });
  const mirror = seeds.filter((s) => !s.preserveOwner).map(toRow);
  const preserve = seeds.filter((s) => s.preserveOwner).map(toRow);

  if (mirror.length > 0) {
    await db
      .insert(resources)
      .values(mirror)
      .onConflictDoUpdate({
        target: [resources.provider, resources.type, resources.externalId],
        set: {
          name: sql`excluded.name`,
          ownerCustomerId: sql`excluded.owner_customer_id`,
          connectionId: sql`excluded.connection_id`,
          metadata: sql`excluded.metadata`,
          lastSeenAt: sql`excluded.last_seen_at`,
          // A source seeing it again brings a decommissioned CI back.
          status: sql`'active'`,
        },
      });
  }
  if (preserve.length > 0) {
    await db
      .insert(resources)
      .values(preserve)
      .onConflictDoUpdate({
        target: [resources.provider, resources.type, resources.externalId],
        set: {
          name: sql`excluded.name`,
          // Keep a manually-set owner; only fill it in when still null.
          ownerCustomerId: sql`coalesce(${resources.ownerCustomerId}, excluded.owner_customer_id)`,
          connectionId: sql`excluded.connection_id`,
          metadata: sql`excluded.metadata`,
          lastSeenAt: sql`excluded.last_seen_at`,
          status: sql`'active'`,
        },
      });
  }
}

// A resource the source stopped reporting is decommissioned, not deleted:
// owner, cost history and audit trail stay; a later sighting re-activates it.
async function pruneStale(
  provider: ResourceProviderValue,
  connectionId: string,
  types: ResourceTypeValue[],
  seenAt: Date,
): Promise<void> {
  const stale = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.provider, provider),
        eq(resources.connectionId, connectionId),
        inArray(resources.type, types),
        eq(resources.status, "active"),
        lt(resources.lastSeenAt, seenAt),
      ),
    );
  await setResourceStatus({
    resourceIds: stale.map((r) => r.id),
    status: "decommissioned",
    actor: "worker",
  });
}

const asIso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** Project an AWS asset's typed inventory into Domain CIs (one per domain name)
 * with per-source facets (registry, dns, ses, cloudfront, acm). SES tenants stay
 * separate (customer-shaped). Retires the old per-facet resource rows. */
export async function syncAwsResources(
  asset: AssetRef,
  raw: Record<string, unknown>,
): Promise<void> {
  if (!asset.connectionId) return;
  const conn = asset.connectionId;
  const seenAt = new Date();

  const [domainRows, webRows, certRows, customerRows] = await Promise.all([
    db.select().from(domains).where(eq(domains.assetId, asset.id)),
    db.select().from(webDistributions).where(eq(webDistributions.assetId, asset.id)),
    db
      .select()
      .from(certificates)
      .where(and(eq(certificates.assetId, asset.id), eq(certificates.source, "acm"))),
    db.select({ id: customers.id, name: customers.name }).from(customers),
  ]);

  for (const d of domainRows) {
    const id = await reconcileDomain(d.name, d.customerId);
    if (!id) continue;
    if (d.hostedZoneId != null || d.recordCount != null || d.dnssecEnabled != null) {
      await upsertCIFacet(
        id,
        "dns",
        {
          hostedZoneId: d.hostedZoneId,
          recordCount: d.recordCount,
          dnssecEnabled: d.dnssecEnabled,
          isPrivateZone: d.isPrivateZone,
        },
        [],
        seenAt,
      );
    }
    if (d.registered) {
      await upsertCIFacet(
        id,
        "registry",
        {
          registrar: d.registrar,
          expiresAt: asIso(d.registryExpiresAt),
          autoRenew: d.autoRenew,
          transferLock: d.transferLock,
        },
        [],
        seenAt,
      );
    }
    if (d.sesVerified) {
      await upsertCIFacet(
        id,
        "ses",
        { sendingEnabled: d.sesSendingEnabled, region: d.sesRegion },
        [],
        seenAt,
      );
    }
  }

  for (const w of webRows) {
    const alias = w.primaryAlias ?? w.aliases?.[0];
    if (!alias) continue;
    const id = await reconcileDomain(alias, w.customerId);
    if (!id) continue;
    await upsertCIFacet(
      id,
      "cloudfront",
      {
        distributionId: w.distributionId,
        aliases: w.aliases,
        behavior: w.behavior,
        status: w.status,
        originDomain: w.originDomain,
      },
      [],
      seenAt,
    );
  }

  for (const c of certRows) {
    if (!c.commonName) continue;
    const id = await reconcileDomain(c.commonName, c.customerId);
    if (!id) continue;
    await upsertCIFacet(id, "acm", { expiresAt: asIso(c.notAfter) }, [], seenAt);
  }

  const tenants = (
    raw.tenants as { list?: { name: string; id: string; arn: string }[] } | undefined
  )?.list;
  const tenantSeeds = awsTenantSeeds({ tenants: tenants ?? [], customers: customerRows });
  if (tenantSeeds.length > 0) await upsertSeeds(tenantSeeds, "aws", conn, seenAt);

  // Retire the old per-facet aws domain resource types (folded into domain CIs).
  await pruneStale(
    "aws",
    conn,
    ["dns_zone", "registered_domain", "ses_identity", "cloudfront_distribution", "acm_cert"],
    seenAt,
  );
  if (Array.isArray(tenants)) await pruneStale("aws", conn, ["ses_tenant"], seenAt);
}

/** Project a mailcow asset's domains into Domain CIs (mailcow facet) and its
 * mailboxes into resources parented onto those domain CIs. */
export async function syncMailResources(asset: AssetRef): Promise<void> {
  if (!asset.connectionId) return;
  const conn = asset.connectionId;
  const seenAt = new Date();

  const [mailDomainRows, mailboxRows] = await Promise.all([
    db.select().from(mailDomains).where(eq(mailDomains.assetId, asset.id)),
    db.select().from(mailboxes).where(eq(mailboxes.assetId, asset.id)),
  ]);

  for (const d of mailDomainRows) {
    const id = await reconcileDomain(d.name, d.customerId);
    if (!id) continue;
    await upsertCIFacet(
      id,
      "mailcow",
      { active: d.active, mailboxCount: d.mailboxCount, aliasCount: d.aliasCount },
      [],
      seenAt,
    );
  }

  const seeds = mailboxResourceSeeds(mailboxRows);
  await upsertSeeds(seeds, "mailcow", conn, seenAt);

  // Parent each mailbox onto its Domain CI.
  await db.execute(sql`
    update resources child
    set parent_resource_id = parent.id
    from resources parent
    where child.provider = 'mailcow' and child.type = 'mailbox'
      and child.connection_id = ${conn}
      and parent.type = 'domain'
      and parent.external_id = (child.metadata->>'domainName')
      and child.parent_resource_id is distinct from parent.id
  `);

  await pruneStale("mailcow", conn, ["mail_domain", "mailbox"], seenAt);
}

interface HetznerCloudServerRow {
  ipv4: string | null;
  name: string;
  serverType: string | null;
  cores: number | null;
  memoryGb: number | null;
  diskGb: number | null;
  location: string | null;
  status: string;
  monthlyPriceCents: number | null;
}

/**
 * Reconcile Hetzner Cloud servers onto host CIs (by public IP, matching what SSM
 * contributed), write the hetznerCloud hardware facet, and upsert a per-host cost
 * pool for the current period from the server's monthly price. The per-host
 * allocator then splits that pool across the host's containers automatically.
 */
export async function syncHetznerCloudResources(
  _asset: AssetRef,
  raw: Record<string, unknown>,
): Promise<void> {
  const block = raw.servers as { list?: HetznerCloudServerRow[] } | undefined;
  const list = block?.list;
  if (!Array.isArray(list) || list.length === 0) return;
  const seenAt = new Date();
  const period = periodOf(seenAt);
  const seenHostIds = new Set<string>();

  for (const s of list) {
    const ips = s.ipv4 ? [s.ipv4] : [];
    const hostId = await reconcileHost({ ips, name: s.name });
    seenHostIds.add(hostId);
    await upsertCIFacet(
      hostId,
      "hetznerCloud",
      {
        serverType: s.serverType,
        location: s.location,
        status: s.status,
        cores: s.cores,
        memoryGb: s.memoryGb,
        diskGb: s.diskGb,
        monthlyPriceCents: s.monthlyPriceCents,
      },
      ips,
      seenAt,
    );

    if (s.monthlyPriceCents != null) {
      // Label the pool by the host's canonical id (FQDN when known) so it stays
      // stable across checks and reads nicely on the margin page.
      const [hostRow] = await db
        .select({ ext: resources.externalId })
        .from(resources)
        .where(eq(resources.id, hostId))
        .limit(1);
      const label = hostRow?.ext ?? s.name;
      await db
        .insert(providerCosts)
        .values({
          provider: "hetzner",
          period,
          label,
          resourceId: hostId,
          source: "metered",
          amountCents: s.monthlyPriceCents,
          currency: "EUR",
        })
        .onConflictDoUpdate({
          target: [providerCosts.provider, providerCosts.period, providerCosts.label],
          set: { amountCents: s.monthlyPriceCents, resourceId: hostId, source: "metered" },
        });
    }
  }

  // Prune this period's metered Hetzner pools whose host is no longer in the
  // account (server removed/renamed) so a stale box price doesn't keep inflating
  // cost. Never touches manual (source='fixed') pools.
  if (seenHostIds.size > 0) {
    await db
      .delete(providerCosts)
      .where(
        and(
          eq(providerCosts.provider, "hetzner"),
          eq(providerCosts.period, period),
          eq(providerCosts.source, "metered"),
          isNotNull(providerCosts.resourceId),
          notInArray(providerCosts.resourceId, [...seenHostIds]),
        ),
      );
  }
}

/** Project a Railway account's projects + services into resources. */
export async function syncRailwayResources(
  asset: AssetRef,
  raw: Record<string, unknown>,
): Promise<void> {
  if (!asset.connectionId) return;
  const conn = asset.connectionId;
  const projectsBlock = raw.projects as { list?: unknown } | undefined;
  if (!projectsBlock || !Array.isArray(projectsBlock.list)) return;
  const seenAt = new Date();

  const seeds = railwayResourceSeeds(
    projectsBlock.list as { id: string; name: string; services: { id: string; name: string }[] }[],
  );

  await upsertSeeds(seeds, "railway", conn, seenAt);

  // Link each service to its project.
  await db.execute(sql`
    update resources child
    set parent_resource_id = parent.id
    from resources parent
    where child.provider = 'railway' and child.type = 'railway_service'
      and child.connection_id = ${conn}
      and parent.provider = 'railway' and parent.type = 'railway_project'
      and parent.external_id = (child.metadata->>'projectId')
      and child.parent_resource_id is distinct from parent.id
  `);

  // A Railway project is one customer's app, so its services inherit the project's
  // owner for cost roll-up. Only fills services with no owner of their own, so a
  // hand-set service owner still wins; this is how per-project Railway spend
  // reaches the customer once the operator assigns the project to one.
  await db.execute(sql`
    update resources child
    set owner_customer_id = parent.owner_customer_id
    from resources parent
    where child.provider = 'railway' and child.type = 'railway_service'
      and child.connection_id = ${conn}
      and parent.id = child.parent_resource_id
      and parent.owner_customer_id is not null
      and child.owner_customer_id is null
  `);

  await pruneStale("railway", conn, ["railway_project", "railway_service"], seenAt);
}
