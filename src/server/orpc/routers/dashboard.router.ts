import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { loadMarginReport, loadReadiness } from "../../billing/service";
import type { CheckStatus } from "../../connectors/types";
import { periodOf } from "../../costs/margin";
import { db } from "../../db";
import { assets, checkResults } from "../../db/schema/assets";
import { domains } from "../../db/schema/aws";
import { certificates } from "../../db/schema/certs";
import { customerRelations, customers } from "../../db/schema/customers";
import { incidents } from "../../db/schema/incidents";
import { mailDomains } from "../../db/schema/mail";
import { resourceHistory, resources } from "../../db/schema/resources";
import { mailEdgeId } from "../../mail/edge";
import { checksQueue } from "../../queue/checks.queue";
import { readWorkerHeartbeat } from "../../queue/heartbeat";
import { mailPollQueue } from "../../queue/mail-poll.queue";
import { authed } from "../base";

const EXPIRY_SOON_DAYS = 45;
const WORKER_ALIVE_MS = 60_000;

// Worst-wins ordering so a location glows by its most severe asset.
const STATUS_RANK: Record<CheckStatus, number> = { down: 3, degraded: 2, unknown: 1, up: 0 };
function aggregateStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return "unknown";
  return statuses.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), "up");
}

export const dashboardRouter = {
  overview: authed.handler(async () => {
    const counts = await db
      .select({
        status: assets.lastStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(assets)
      .groupBy(assets.lastStatus);

    const totals: Record<CheckStatus, number> & { total: number } = {
      up: 0,
      down: 0,
      degraded: 0,
      unknown: 0,
      total: 0,
    };
    for (const row of counts) {
      totals[row.status] = row.count;
      totals.total += row.count;
    }

    const failing = await db
      .select({
        ...getTableColumns(assets),
        // The latest check message -- the human reason for down/degraded.
        message: sql<
          string | null
        >`(select message from ${checkResults} where ${checkResults.assetId} = ${assets}."id" order by ${checkResults.checkedAt} desc limit 1)`,
      })
      .from(assets)
      .where(inArray(assets.lastStatus, ["down", "degraded"]))
      .orderBy(desc(assets.lastCheckedAt))
      .limit(10);

    // Mail server highlights: latest check metadata per mailcow asset.
    const mailcowAssets = await db
      .select({ id: assets.id, name: assets.name, status: assets.lastStatus })
      .from(assets)
      .where(eq(assets.connectorId, "mailcow"));

    const mailcow = await Promise.all(
      mailcowAssets.map(async (asset) => {
        const [latest] = await db
          .select({ metadata: checkResults.metadata })
          .from(checkResults)
          .where(and(eq(checkResults.assetId, asset.id)))
          .orderBy(desc(checkResults.checkedAt))
          .limit(1);
        return { ...asset, metadata: latest?.metadata ?? null };
      }),
    );

    // Unified "expiring soon": registered domains + certificates (high-value,
    // otherwise invisible). Each entry is a renewal the operator must act on.
    const soon = new Date(Date.now() + EXPIRY_SOON_DAYS * 86_400_000);
    const expiringDomains = await db
      .select({
        name: domains.name,
        expiresAt: domains.registryExpiresAt,
        autoRenew: domains.autoRenew,
        locationName: customers.name,
      })
      .from(domains)
      .leftJoin(customers, eq(domains.customerId, customers.id))
      .where(
        and(
          eq(domains.registered, true),
          eq(domains.decommissioned, false),
          isNotNull(domains.registryExpiresAt),
          lte(domains.registryExpiresAt, soon),
        ),
      );
    const expiringCerts = await db
      .select({
        name: certificates.commonName,
        expiresAt: certificates.notAfter,
        source: certificates.source,
        locationName: customers.name,
      })
      .from(certificates)
      .leftJoin(customers, eq(certificates.customerId, customers.id))
      .where(and(isNotNull(certificates.notAfter), lte(certificates.notAfter, soon)));

    const renewals = [
      ...expiringDomains.map((d) => ({
        kind: "domain" as const,
        name: d.name,
        expiresAt: d.expiresAt,
        autoRenew: d.autoRenew,
        source: null as string | null,
        locationName: d.locationName,
      })),
      ...expiringCerts.map((c) => ({
        kind: "certificate" as const,
        name: c.name,
        expiresAt: c.expiresAt,
        autoRenew: null as boolean | null,
        source: c.source as string | null,
        locationName: c.locationName,
      })),
    ]
      .filter((r) => r.expiresAt)
      .sort((a, b) => new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime())
      .slice(0, 12);

    // Open incidents with the asset name and how long they have been running.
    const openIncidents = await db
      .select({
        id: incidents.id,
        assetId: incidents.assetId,
        assetName: assets.name,
        status: incidents.status,
        startedAt: incidents.startedAt,
        acknowledgedAt: incidents.acknowledgedAt,
      })
      .from(incidents)
      .leftJoin(assets, eq(incidents.assetId, assets.id))
      .where(isNull(incidents.endedAt))
      .orderBy(asc(incidents.startedAt));

    return { totals, failing, mailcow, renewals, openIncidents };
  }),

  // Health of the monitor itself: is the worker alive, how deep is the queue, and
  // which enabled assets have gone stale (not checked in ~2x their interval).
  systemHealth: authed.handler(async () => {
    const heartbeat = await readWorkerHeartbeat();
    const now = Date.now();
    const worker = {
      lastSeenAt: heartbeat ? new Date(heartbeat) : null,
      alive: heartbeat != null && now - heartbeat < WORKER_ALIVE_MS,
    };

    const [checks, mail] = await Promise.all([
      checksQueue.getJobCounts("waiting", "active", "delayed", "failed"),
      mailPollQueue.getJobCounts("waiting", "active", "delayed", "failed"),
    ]);

    // Stale: enabled and overdue by more than 2x the interval
    // (min 120s grace), or never checked at all.
    const stale = await db
      .select({
        id: assets.id,
        name: assets.name,
        connectorId: assets.connectorId,
        lastStatus: assets.lastStatus,
        lastCheckedAt: assets.lastCheckedAt,
        intervalSeconds: assets.intervalSeconds,
      })
      .from(assets)
      .where(
        and(
          eq(assets.enabled, true),
          or(
            isNull(assets.lastCheckedAt),
            sql`${assets.lastCheckedAt} < now() - make_interval(secs => greatest(${assets.intervalSeconds} * 2, 120))`,
          ),
        ),
      )
      .orderBy(assets.name);

    return { worker, queues: { checks, mail }, stale };
  }),

  // Everything the infrastructure map needs in one payload: location pins (nodes
  // with an aggregated status and their assets), location-to-location edges, and
  // the assets not yet assigned to any location.
  map: authed.handler(async () => {
    const locationRows = await db.select().from(customers).orderBy(customers.name);
    const edges = await db.select().from(customerRelations);

    const placedAssets = await db
      .select({
        id: assets.id,
        name: assets.name,
        connectorId: assets.connectorId,
        lastStatus: assets.lastStatus,
        lastLatencyMs: assets.lastLatencyMs,
        customerId: assets.customerId,
      })
      .from(assets)
      .where(isNotNull(assets.customerId))
      .orderBy(assets.name);

    const byLocation = new Map<string, typeof placedAssets>();
    for (const asset of placedAssets) {
      const list = byLocation.get(asset.customerId!) ?? [];
      list.push(asset);
      byLocation.set(asset.customerId!, list);
    }
    // assetId -> the location where that asset (e.g. a mailcow server) sits.
    const assetLocation = new Map(placedAssets.map((a) => [a.id, a.customerId!]));

    // Mail domains assigned to a customer, grouped by that customer's location.
    const allDomains = await db
      .select({
        assetId: mailDomains.assetId,
        name: mailDomains.name,
        customerId: mailDomains.customerId,
        mailboxCount: mailDomains.mailboxCount,
        active: mailDomains.active,
      })
      .from(mailDomains);

    const domainsByLocation = new Map<
      string,
      { name: string; mailboxCount: number; active: boolean }[]
    >();
    for (const d of allDomains) {
      if (!d.customerId) continue;
      const list = domainsByLocation.get(d.customerId) ?? [];
      list.push({ name: d.name, mailboxCount: d.mailboxCount, active: d.active });
      domainsByLocation.set(d.customerId, list);
    }

    // Per-customer capability markers, derived from the owned resources so they
    // match the Customers page (mail is true when a customer owns a mailbox even
    // if a different customer owns the domain).
    const capRows = await db
      .select({
        ownerCustomerId: resources.ownerCustomerId,
        type: resources.type,
        registryExpiresAt: sql<string | null>`${resources.metadata}->>'registryExpiresAt'`,
      })
      .from(resources)
      .where(and(isNotNull(resources.ownerCustomerId), eq(resources.status, "active")));

    type Cap = {
      hasDns: boolean;
      hasMail: boolean;
      hasWeb: boolean;
      hasRegistry: boolean;
      hasCloudfront: boolean;
      registryExpiresAt: Date | null;
    };
    const capByLocation = new Map<string, Cap>();
    const resourceCountByLocation = new Map<string, number>();
    const cap = (id: string): Cap => {
      let c = capByLocation.get(id);
      if (!c) {
        c = {
          hasDns: false,
          hasMail: false,
          hasWeb: false,
          hasRegistry: false,
          hasCloudfront: false,
          registryExpiresAt: null,
        };
        capByLocation.set(id, c);
      }
      return c;
    };
    for (const r of capRows) {
      if (!r.ownerCustomerId) continue;
      resourceCountByLocation.set(
        r.ownerCustomerId,
        (resourceCountByLocation.get(r.ownerCustomerId) ?? 0) + 1,
      );
      const c = cap(r.ownerCustomerId);
      if (r.type === "dns_zone") c.hasDns = true;
      else if (
        r.type === "cloudfront_distribution" ||
        r.type === "container" ||
        r.type === "railway_service"
      ) {
        c.hasWeb = true;
        // CloudFront is the "protected" subset of web-serving resources.
        if (r.type === "cloudfront_distribution") c.hasCloudfront = true;
      } else if (
        r.type === "mailbox" ||
        r.type === "mail_domain" ||
        r.type === "ses_identity" ||
        r.type === "ses_tenant"
      )
        c.hasMail = true;
      else if (r.type === "registered_domain") {
        c.hasRegistry = true;
        if (r.registryExpiresAt) {
          const exp = new Date(r.registryExpiresAt);
          if (!c.registryExpiresAt || exp < c.registryExpiresAt) c.registryExpiresAt = exp;
        }
      }
    }

    // Only customers with coordinates appear on the map. Others are CRM-only records.
    const nodes = locationRows
      .filter(
        (loc): loc is typeof loc & { latitude: number; longitude: number } =>
          loc.latitude != null && loc.longitude != null,
      )
      .map((loc) => {
        const locAssets = byLocation.get(loc.id) ?? [];
        const locDomains = domainsByLocation.get(loc.id) ?? [];
        const c = capByLocation.get(loc.id) ?? {
          hasDns: false,
          hasMail: false,
          hasWeb: false,
          hasRegistry: false,
          hasCloudfront: false,
          registryExpiresAt: null,
        };
        return {
          id: loc.id,
          name: loc.name,
          kind: loc.kind,
          crmStatus: loc.status,
          latitude: loc.latitude,
          longitude: loc.longitude,
          address: loc.address,
          assetCount: locAssets.length,
          resourceCount: resourceCountByLocation.get(loc.id) ?? 0,
          status: aggregateStatus(locAssets.map((a) => a.lastStatus)),
          assets: locAssets.map((a) => ({
            id: a.id,
            name: a.name,
            connectorId: a.connectorId,
            lastStatus: a.lastStatus,
            lastLatencyMs: a.lastLatencyMs,
          })),
          domains: locDomains,
          domainCount: locDomains.length,
          mailboxCount: locDomains.reduce((s, d) => s + d.mailboxCount, 0),
          capabilities: c,
        };
      });

    // Derived "mail" edges: from the mailcow server's location to each customer
    // location it serves, deduped. Only when both ends are placed and differ.
    const derivedKeys = new Set<string>();
    const derivedEdges = [];
    for (const d of allDomains) {
      if (!d.customerId) continue;
      const serverLoc = assetLocation.get(d.assetId);
      if (!serverLoc || serverLoc === d.customerId) continue;
      const key = `${serverLoc}:${d.customerId}`;
      if (derivedKeys.has(key)) continue;
      derivedKeys.add(key);
      derivedEdges.push({
        id: mailEdgeId(serverLoc, d.customerId),
        fromCustomerId: serverLoc,
        toCustomerId: d.customerId,
        type: "feeds",
        label: null,
        kind: "mail",
        derived: true,
      });
    }

    const explicitEdges = edges.map((e) => ({ ...e, kind: "relation", derived: false }));

    const unplacedAssets = await db
      .select({
        id: assets.id,
        name: assets.name,
        connectorId: assets.connectorId,
        lastStatus: assets.lastStatus,
      })
      .from(assets)
      .where(sql`${assets.customerId} is null`)
      .orderBy(assets.name);

    return { nodes, edges: [...explicitEdges, ...derivedEdges], unplacedAssets };
  }),

  // The operator cockpit: money for the period, everything that needs a human,
  // the inventory rollup, the newest audit-trail entries and a demoted
  // monitoring strip. One payload so the dashboard is a single round trip.
  cockpit: authed.handler(async () => {
    const period = periodOf(new Date());
    const soon = new Date(Date.now() + EXPIRY_SOON_DAYS * 86_400_000);

    const [
      margin,
      readiness,
      heartbeat,
      statusCounts,
      failing,
      mailcowAssets,
      expiringDomains,
      expiringCerts,
      openIncidents,
      staleRows,
      inventoryRows,
      changeRows,
    ] = await Promise.all([
      loadMarginReport(period),
      loadReadiness(period),
      readWorkerHeartbeat(),
      db
        .select({ status: assets.lastStatus, count: sql<number>`count(*)::int` })
        .from(assets)
        .groupBy(assets.lastStatus),
      db
        .select({
          id: assets.id,
          name: assets.name,
          target: assets.target,
          lastStatus: assets.lastStatus,
          lastLatencyMs: assets.lastLatencyMs,
          lastCheckedAt: assets.lastCheckedAt,
        })
        .from(assets)
        .where(inArray(assets.lastStatus, ["down", "degraded"]))
        .orderBy(desc(assets.lastCheckedAt))
        .limit(6),
      db
        .select({ id: assets.id, name: assets.name, status: assets.lastStatus })
        .from(assets)
        .where(eq(assets.connectorId, "mailcow")),
      db
        .select({ name: domains.name, expiresAt: domains.registryExpiresAt })
        .from(domains)
        .where(
          and(
            eq(domains.registered, true),
            eq(domains.decommissioned, false),
            isNotNull(domains.registryExpiresAt),
            lte(domains.registryExpiresAt, soon),
          ),
        ),
      db
        .select({ name: certificates.commonName, expiresAt: certificates.notAfter })
        .from(certificates)
        .where(and(isNotNull(certificates.notAfter), lte(certificates.notAfter, soon))),
      db
        .select({
          id: incidents.id,
          assetId: incidents.assetId,
          assetName: assets.name,
          status: incidents.status,
          startedAt: incidents.startedAt,
          acknowledgedAt: incidents.acknowledgedAt,
        })
        .from(incidents)
        .leftJoin(assets, eq(incidents.assetId, assets.id))
        .where(isNull(incidents.endedAt))
        .orderBy(asc(incidents.startedAt))
        .limit(10),
      db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.enabled, true),
            or(
              isNull(assets.lastCheckedAt),
              sql`${assets.lastCheckedAt} < now() - make_interval(secs => greatest(${assets.intervalSeconds} * 2, 120))`,
            ),
          ),
        ),
      db
        .select({ type: resources.type, count: sql<number>`count(*)::int` })
        .from(resources)
        .where(eq(resources.status, "active"))
        .groupBy(resources.type),
      db
        .select({
          id: resourceHistory.id,
          resourceId: resourceHistory.resourceId,
          resourceName: resources.name,
          resourceType: resources.type,
          field: resourceHistory.field,
          oldValue: resourceHistory.oldValue,
          newValue: resourceHistory.newValue,
          actor: resourceHistory.actor,
          createdAt: resourceHistory.createdAt,
        })
        .from(resourceHistory)
        .leftJoin(resources, eq(resourceHistory.resourceId, resources.id))
        .orderBy(desc(resourceHistory.createdAt))
        .limit(10),
    ]);

    const totals: Record<CheckStatus, number> & { total: number } = {
      up: 0,
      down: 0,
      degraded: 0,
      unknown: 0,
      total: 0,
    };
    for (const row of statusCounts) {
      totals[row.status] = row.count;
      totals.total += row.count;
    }

    const mailcow = await Promise.all(
      mailcowAssets.map(async (asset) => {
        const [latest] = await db
          .select({ metadata: checkResults.metadata })
          .from(checkResults)
          .where(eq(checkResults.assetId, asset.id))
          .orderBy(desc(checkResults.checkedAt))
          .limit(1);
        return { ...asset, metadata: latest?.metadata ?? null };
      }),
    );

    // Days until the nearest renewal across both kinds, so the action row can
    // say how urgent the whole group is.
    const nextExpiry = [...expiringDomains, ...expiringCerts]
      .map((r) => (r.expiresAt ? new Date(r.expiresAt).getTime() : null))
      .filter((t): t is number => t != null)
      .sort((a, b) => a - b)[0];
    const expiringSoonestDays =
      nextExpiry == null ? null : Math.floor((nextExpiry - Date.now()) / 86_400_000);

    const uncoveredPoolCents = readiness.uncoveredPools.reduce((s, p) => s + p.amountCents, 0);

    return {
      period,
      money: {
        costCents: margin.totalCostCents,
        chargeCents: margin.totalChargeCents,
        marginCents: margin.totalMarginCents,
        overheadCents: margin.unallocatedCostCents,
      },
      attention: {
        unassignedCount: readiness.unassigned.filter((r) => r.costCents > 0).length,
        unassignedCostCents: readiness.unassignedCostCents,
        unpricedCount: readiness.unpriced.length,
        uncoveredPoolCount: readiness.uncoveredPools.length,
        uncoveredPoolCents,
        expiringDomainCount: expiringDomains.length,
        expiringCertCount: expiringCerts.length,
        expiringSoonestDays,
        openIncidentCount: openIncidents.length,
        staleCheckCount: staleRows.length,
        workerAlive: heartbeat != null && Date.now() - heartbeat < WORKER_ALIVE_MS,
      },
      workerLastSeenAt: heartbeat ? new Date(heartbeat) : null,
      inventory: inventoryRows.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      changes: changeRows,
      incidents: openIncidents,
      monitoring: { totals, failing, mailcow },
    };
  }),
};
