import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { resourceCostMap } from "../../costs/billing";
import { periodOf } from "../../costs/margin";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { costAllocations, providerCosts } from "../../db/schema/costs";
import { customers } from "../../db/schema/customers";
import { resourceSources } from "../../db/schema/resource-sources";
import { resourceHistory, resources } from "../../db/schema/resources";
import { ssmPatches } from "../../db/schema/ssm";
import { assignOwnerWithHistory, setResourceStatus } from "../../resources/history";
import { authed } from "../base";

export const resourcesRouter = {
  // The unified cross-provider inventory with its owner. Optional filters by
  // provider or owning customer. Feeds the per-customer attribution + cost views.
  list: authed
    .input(
      v.optional(
        v.object({
          provider: v.optional(v.string()),
          customerId: v.optional(v.string()),
          // Default: only active CIs. Decommissioned ones stay readable on request.
          status: v.optional(v.picklist(["active", "decommissioned", "all"])),
        }),
      ),
    )
    .handler(async ({ input }) => {
      const status = input?.status ?? "active";
      const rows = await db
        .select({
          id: resources.id,
          type: resources.type,
          provider: resources.provider,
          externalId: resources.externalId,
          name: resources.name,
          status: resources.status,
          ownerCustomerId: resources.ownerCustomerId,
          ownerName: customers.name,
          parentResourceId: resources.parentResourceId,
          metadata: resources.metadata,
          lastSeenAt: resources.lastSeenAt,
        })
        .from(resources)
        .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
        .where(status === "all" ? undefined : eq(resources.status, status))
        .orderBy(asc(resources.provider), asc(resources.type), asc(resources.name));

      return rows.filter(
        (r) =>
          (!input?.provider || r.provider === input.provider) &&
          (!input?.customerId || r.ownerCustomerId === input.customerId),
      );
    }),

  // The object explorer: every CI with owner, parent, lifecycle status and the
  // cost it draws this period. Filtering happens client-side on this one payload
  // (a few hundred rows), keyed by URL search params so views are shareable.
  explore: authed.handler(async () => {
    const period = periodOf(new Date());
    const [rows, allocRows, poolRows] = await Promise.all([
      db
        .select({
          id: resources.id,
          type: resources.type,
          provider: resources.provider,
          externalId: resources.externalId,
          name: resources.name,
          status: resources.status,
          ownerCustomerId: resources.ownerCustomerId,
          ownerName: customers.name,
          parentResourceId: resources.parentResourceId,
          lastSeenAt: resources.lastSeenAt,
        })
        .from(resources)
        .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
        .orderBy(asc(resources.type), asc(resources.name)),
      db.select().from(costAllocations).where(eq(costAllocations.period, period)),
      db
        .select({ id: providerCosts.id, amountCents: providerCosts.amountCents })
        .from(providerCosts)
        .where(eq(providerCosts.period, period)),
    ]);
    const cost = resourceCostMap(allocRows, poolRows);
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    return {
      period,
      rows: rows.map((r) => ({
        ...r,
        parentName: r.parentResourceId ? (nameById.get(r.parentResourceId) ?? null) : null,
        costCents: cost.get(r.id) ?? 0,
      })),
    };
  }),

  setStatus: authed
    .input(
      v.object({
        resourceIds: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(500)),
        status: v.picklist(["active", "decommissioned"]),
      }),
    )
    .handler(async ({ input, context }) => {
      const updated = await setResourceStatus({
        resourceIds: input.resourceIds,
        status: input.status,
        actor: `user:${context.user.email ?? context.user.id}`,
      });
      return { ok: true, updated };
    }),

  // Host CIs with a rollup for the Hosts list: owner, SSM patch/ping facet,
  // container count, and monitoring status from the linked asset.
  listHosts: authed.handler(async () => {
    const hosts = await db
      .select({
        id: resources.id,
        name: resources.name,
        externalId: resources.externalId,
        ownerCustomerId: resources.ownerCustomerId,
        ownerName: customers.name,
        lastSeenAt: resources.lastSeenAt,
      })
      .from(resources)
      .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
      .where(and(eq(resources.type, "host"), eq(resources.status, "active")))
      .orderBy(asc(resources.name));
    if (hosts.length === 0) return [];
    const ids = hosts.map((h) => h.id);

    const [facets, children, monitors] = await Promise.all([
      db
        .select({
          resourceId: resourceSources.resourceId,
          source: resourceSources.source,
          data: resourceSources.data,
        })
        .from(resourceSources)
        .where(inArray(resourceSources.resourceId, ids)),
      db
        .select({ parentResourceId: resources.parentResourceId })
        .from(resources)
        .where(and(inArray(resources.parentResourceId, ids), eq(resources.type, "container"))),
      db
        .select({ resourceId: assets.resourceId, lastStatus: assets.lastStatus })
        .from(assets)
        .where(inArray(assets.resourceId, ids)),
    ]);

    const ssmByHost = new Map<string, Record<string, unknown>>();
    for (const f of facets) {
      if (f.source === "ssm") ssmByHost.set(f.resourceId, f.data);
    }
    const containerCount = new Map<string, number>();
    for (const c of children) {
      if (c.parentResourceId)
        containerCount.set(c.parentResourceId, (containerCount.get(c.parentResourceId) ?? 0) + 1);
    }
    const monitorByHost = new Map<string, string>();
    for (const m of monitors) if (m.resourceId) monitorByHost.set(m.resourceId, m.lastStatus);

    return hosts.map((h) => {
      const ssm = ssmByHost.get(h.id) ?? null;
      return {
        ...h,
        pingStatus: (ssm?.pingStatus as string | null) ?? null,
        monitorStatus: monitorByHost.get(h.id) ?? null,
        platform: (ssm?.platformName as string | null) ?? null,
        patchMissing: (ssm?.patchMissing as number | null) ?? null,
        patchMissingCritical: (ssm?.patchMissingCritical as number | null) ?? null,
        containerCount: containerCount.get(h.id) ?? 0,
      };
    });
  }),

  // One Configuration Item with everything a source contributed: its per-source
  // facets, child resources (e.g. a host's containers), the monitoring asset
  // linked to it, and (for hosts) the SSM patch timeline. Powers the CI detail page.
  get: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    const [resource] = await db
      .select({
        id: resources.id,
        type: resources.type,
        provider: resources.provider,
        externalId: resources.externalId,
        name: resources.name,
        status: resources.status,
        ownerCustomerId: resources.ownerCustomerId,
        ownerName: customers.name,
        parentResourceId: resources.parentResourceId,
        metadata: resources.metadata,
        lastSeenAt: resources.lastSeenAt,
        createdAt: resources.createdAt,
      })
      .from(resources)
      .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
      .where(eq(resources.id, input.id))
      .limit(1);
    if (!resource) throw new ORPCError("NOT_FOUND", { message: "Ressource nicht gefunden" });

    const [facets, children, monitorRows, patchRows, historyRows, parentRows] = await Promise.all([
      db
        .select({
          source: resourceSources.source,
          data: resourceSources.data,
          ips: resourceSources.ips,
          lastSeenAt: resourceSources.lastSeenAt,
        })
        .from(resourceSources)
        .where(eq(resourceSources.resourceId, input.id))
        .orderBy(asc(resourceSources.source)),
      db
        .select({
          id: resources.id,
          type: resources.type,
          provider: resources.provider,
          name: resources.name,
          ownerCustomerId: resources.ownerCustomerId,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(eq(resources.parentResourceId, input.id))
        .orderBy(asc(resources.name)),
      db
        .select({
          id: assets.id,
          lastStatus: assets.lastStatus,
          lastLatencyMs: assets.lastLatencyMs,
          lastCheckedAt: assets.lastCheckedAt,
          enabled: assets.enabled,
        })
        .from(assets)
        .where(eq(assets.resourceId, input.id))
        .limit(1),
      db
        .select({
          title: ssmPatches.title,
          severity: ssmPatches.severity,
          state: ssmPatches.state,
          installedAt: ssmPatches.installedAt,
        })
        .from(ssmPatches)
        .where(eq(ssmPatches.resourceId, input.id)),
      db
        .select()
        .from(resourceHistory)
        .where(eq(resourceHistory.resourceId, input.id))
        .orderBy(desc(resourceHistory.createdAt))
        .limit(100),
      resource.parentResourceId
        ? db
            .select({ id: resources.id, name: resources.name, type: resources.type })
            .from(resources)
            .where(eq(resources.id, resource.parentResourceId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const installed = patchRows
      .filter((p) => p.state === "Installed")
      .sort((a, b) => (b.installedAt?.getTime() ?? 0) - (a.installedAt?.getTime() ?? 0));
    const missing = patchRows.filter((p) => p.state === "Missing");

    // For a domain, which host serves it: a container whose Traefik hosts include
    // the domain (apex or www), joined to its host CI. The CMDB graph edge.
    let servedBy: { id: string; name: string }[] = [];
    if (resource.type === "domain") {
      const rows = await db.execute(sql`
        select distinct h.id, h.name
        from resources c
        join resources h on c.parent_resource_id = h.id and h.type = 'host'
        where c.type = 'container'
          and c.metadata->'hosts' ?| array[${resource.externalId}, ${`www.${resource.externalId}`}]
      `);
      servedBy = (rows.rows as { id: string; name: string }[]).map((r) => ({
        id: r.id,
        name: r.name,
      }));
    }

    return {
      resource,
      facets,
      children,
      monitor: monitorRows[0] ?? null,
      patches: { installed, missing },
      servedBy,
      history: historyRows,
      parent: parentRows[0] ?? null,
    };
  }),

  // Domain CIs with a rollup for the Domains list: owner, a facet summary
  // (registrar/expiry, cloudfront behavior, mailbox count) and which sources touch it.
  listDomains: authed.handler(async () => {
    const domainRows = await db
      .select({
        id: resources.id,
        name: resources.name,
        ownerCustomerId: resources.ownerCustomerId,
        ownerName: customers.name,
        lastSeenAt: resources.lastSeenAt,
      })
      .from(resources)
      .leftJoin(customers, eq(resources.ownerCustomerId, customers.id))
      .where(and(eq(resources.type, "domain"), eq(resources.status, "active")))
      .orderBy(asc(resources.name));
    if (domainRows.length === 0) return [];
    const ids = domainRows.map((d) => d.id);

    const facets = await db
      .select({
        resourceId: resourceSources.resourceId,
        source: resourceSources.source,
        data: resourceSources.data,
      })
      .from(resourceSources)
      .where(inArray(resourceSources.resourceId, ids));
    const bySource = new Map<string, Map<string, Record<string, unknown>>>();
    for (const f of facets) {
      const m = bySource.get(f.resourceId) ?? new Map();
      m.set(f.source, f.data);
      bySource.set(f.resourceId, m);
    }

    return domainRows.map((d) => {
      const m = bySource.get(d.id);
      const registry = m?.get("registry");
      const cloudfront = m?.get("cloudfront");
      const mailcow = m?.get("mailcow");
      return {
        ...d,
        sources: m ? [...m.keys()].sort() : [],
        registrar: (registry?.registrar as string | null) ?? null,
        expiresAt: (registry?.expiresAt as string | null) ?? null,
        cloudfront: cloudfront ? ((cloudfront.behavior as string | null) ?? "serve") : null,
        mailboxCount: (mailcow?.mailboxCount as number | null) ?? null,
      };
    });
  }),

  // Set (or clear) the owning customer of a CI. Human-facing replacement for the
  // MCP-only assign path.
  assignOwner: authed
    .input(v.object({ resourceId: v.string(), customerId: v.nullable(v.string()) }))
    .handler(async ({ input, context }) => {
      if (input.customerId) {
        const [c] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .limit(1);
        if (!c) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
      }
      // Railway services follow their project; every change lands in the audit trail.
      await assignOwnerWithHistory({
        resourceIds: [input.resourceId],
        customerId: input.customerId,
        actor: `user:${context.user.email ?? context.user.id}`,
      });
      return { ok: true };
    }),

  assignOwners: authed
    .input(
      v.object({
        resourceIds: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(500)),
        customerId: v.nullable(v.string()),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.customerId) {
        const [customer] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .limit(1);
        if (!customer) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });
      }
      const updated = await assignOwnerWithHistory({
        resourceIds: input.resourceIds,
        customerId: input.customerId,
        actor: `user:${context.user.email ?? context.user.id}`,
      });
      return { ok: true, updated };
    }),
};
