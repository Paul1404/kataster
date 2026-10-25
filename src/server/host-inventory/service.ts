import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { persistCheckResult } from "../checks/persist";
import { refreshAutoAllocations } from "../costs/auto-allocate";
import { db } from "../db";
import { assets } from "../db/schema/assets";
import { providerCosts } from "../db/schema/costs";
import { hostInventory } from "../db/schema/host-inventory";
import { incidents } from "../db/schema/incidents";
import { mailboxes, mailDomains } from "../db/schema/mail";
import { mcpTokens } from "../db/schema/mcp-tokens";
import { resourceSources } from "../db/schema/resource-sources";
import { resources } from "../db/schema/resources";
import { scheduleAsset, unscheduleAsset, unscheduleMailPoll } from "../queue/schedule";
import { recordResourceHistory, setResourceStatus } from "../resources/history";
import { parseHostSnapshot, summarizeHost } from "./schema";

export async function registerHostToken(hostname: string, tokenHash: string) {
  const [existing] = await db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, tokenHash));
  if (existing) {
    if (existing.scopes.length !== 1 || existing.scopes[0] !== `host:${hostname}`)
      throw new Error("Dieser Token ist bereits anders zugeordnet");
    return { id: existing.id, hostname };
  }
  const [row] = await db
    .insert(mcpTokens)
    .values({
      name: `Hostinventar ${hostname}`,
      tokenHash,
      tokenPrefix: "host-exporter",
      scopes: [`host:${hostname}`],
    })
    .returning({ id: mcpTokens.id });
  return { ...row, hostname };
}

export async function ingestHostSnapshot(input: unknown, actor: string) {
  const snapshot = parseHostSnapshot(input);
  const observedAt = new Date(snapshot.observedAt);
  const period = snapshot.observedAt.slice(0, 7);
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`host-inventory:${snapshot.hostname}`}))`,
    );
    const previous = await tx.query.hostInventory.findFirst({
      where: eq(hostInventory.hostname, snapshot.hostname),
    });
    if (previous && previous.observedAt >= observedAt)
      throw new Error("Hostinventar wurde bereits verarbeitet oder durch neuere Daten ersetzt");
    const all = await tx.select().from(resources);
    const activeIds = new Set<string>();
    async function upsert(
      input: typeof resources.$inferInsert,
      adopted?: typeof resources.$inferSelect,
    ) {
      const existing =
        adopted ??
        all.find(
          (r) =>
            r.provider === input.provider &&
            r.type === input.type &&
            r.externalId === input.externalId,
        );
      if (existing) {
        if (existing.provider !== input.provider)
          await recordResourceHistory(
            [
              {
                resourceId: existing.id,
                field: "provider",
                oldValue: existing.provider,
                newValue: input.provider,
              },
            ],
            actor,
            tx,
          );
        await tx
          .update(resources)
          .set({
            provider: input.provider,
            name: input.name,
            parentResourceId: input.parentResourceId,
            metadata: input.metadata ?? {},
            lastSeenAt: observedAt,
          })
          .where(eq(resources.id, existing.id));
        await setResourceStatus({ resourceIds: [existing.id], status: "active", actor }, tx);
        activeIds.add(existing.id);
        return existing.id;
      }
      const [row] = await tx
        .insert(resources)
        .values({ ...input, lastSeenAt: observedAt })
        .returning({ id: resources.id });
      activeIds.add(row!.id);
      return row!.id;
    }
    const hostId = await upsert({
      type: "host",
      provider: "other",
      externalId: snapshot.hostname,
      name: snapshot.hostname,
      metadata: { provider: "contabo", os: snapshot.os, source: "managed-host" },
    });
    const hostOwner = all.find((r) => r.id === hostId)?.ownerCustomerId ?? null;
    await tx
      .insert(resourceSources)
      .values({
        resourceId: hostId,
        source: "managed-host",
        data: { provider: "Contabo", ...summarizeHost(snapshot).raw },
        lastSeenAt: observedAt,
      })
      .onConflictDoUpdate({
        target: [resourceSources.resourceId, resourceSources.source],
        set: { data: sql`excluded.data`, lastSeenAt: observedAt },
      });
    let [asset] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.connectorId, "managed-host"), eq(assets.target, snapshot.hostname)));
    if (!asset)
      [asset] = await tx
        .insert(assets)
        .values({
          name: `${snapshot.hostname}: Stalwart, GitOps und B2`,
          connectorId: "managed-host",
          target: snapshot.hostname,
          resourceId: hostId,
          intervalSeconds: 900,
        })
        .returning();
    const domainCounts = new Map<string, number>();
    for (const mailbox of snapshot.mailboxes) {
      const old = all.find(
        (r) =>
          r.type === "mailbox" &&
          r.externalId === mailbox.address &&
          (r.provider === "stalwart" || r.provider === "mailcow"),
      );
      await upsert(
        {
          type: "mailbox",
          provider: "stalwart",
          externalId: mailbox.address,
          name: mailbox.name,
          parentResourceId: hostId,
          metadata: {
            source: "managed-host",
            hostname: snapshot.hostname,
            domainName: mailbox.address.split("@")[1],
            usedBytes: mailbox.usedBytes,
          },
        },
        old,
      );
      const domain = mailbox.address.split("@")[1]!;
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      const [typed] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.address, mailbox.address))
        .limit(1);
      if (typed)
        await tx
          .update(mailboxes)
          .set({
            assetId: asset!.id,
            active: true,
            name: mailbox.name,
            quotaUsedBytes: mailbox.usedBytes,
            lastSeenAt: observedAt,
          })
          .where(eq(mailboxes.id, typed.id));
      else
        await tx.insert(mailboxes).values({
          assetId: asset!.id,
          address: mailbox.address,
          domainName: domain,
          name: mailbox.name,
          active: true,
          quotaUsedBytes: mailbox.usedBytes,
        });
    }
    for (const [name, count] of domainCounts) {
      const [typed] = await tx
        .select()
        .from(mailDomains)
        .where(eq(mailDomains.name, name))
        .limit(1);
      if (typed)
        await tx
          .update(mailDomains)
          .set({ assetId: asset!.id, active: true, mailboxCount: count, lastSeenAt: observedAt })
          .where(eq(mailDomains.id, typed.id));
      else
        await tx
          .insert(mailDomains)
          .values({ assetId: asset!.id, name, active: true, mailboxCount: count });
    }
    for (const container of snapshot.containers) {
      const domainOwner = container.domain
        ? all.find((r) => r.type === "domain" && r.externalId === container.domain)?.ownerCustomerId
        : null;
      await upsert({
        type: "container",
        provider: "contabo",
        externalId: `${snapshot.hostname}/${container.site}/${container.name}`,
        name: container.name,
        parentResourceId: hostId,
        ownerCustomerId: domainOwner ?? hostOwner,
        metadata: { ...container, source: "managed-host", hostname: snapshot.hostname },
      });
    }
    const backupId = await upsert({
      type: "backup",
      provider: "backblaze",
      externalId: `${snapshot.hostname}/mail`,
      name: `B2-Backup ${snapshot.hostname}`,
      ownerCustomerId: hostOwner,
      parentResourceId: hostId,
      metadata: {
        ...snapshot.backup,
        encrypted: true,
        source: "managed-host",
        hostname: snapshot.hostname,
      },
    });
    const stale = all.filter(
      (r) =>
        r.parentResourceId === hostId &&
        r.metadata.source === "managed-host" &&
        !activeIds.has(r.id),
    );
    await setResourceStatus(
      { resourceIds: stale.map((r) => r.id), status: "decommissioned", actor },
      tx,
    );
    for (const [provider, amountCents, resourceId, label] of [
      ["contabo", snapshot.hostMonthlyCents, hostId, `Contabo ${snapshot.hostname}`],
      [
        "backblaze",
        snapshot.backupMonthlyCents,
        backupId,
        `Backblaze B2 ${snapshot.hostname} (Speicherschätzung)`,
      ],
    ] as const) {
      if (amountCents == null) continue;
      await tx
        .insert(providerCosts)
        .values({
          provider,
          period,
          label,
          amountCents,
          resourceId,
          source: "fixed",
          metadata: {
            source: "host-configuration",
            estimated: provider === "backblaze",
            billingBasis: "monthly-not-invoice",
            observedAt: snapshot.observedAt,
          },
        })
        .onConflictDoUpdate({
          target: [providerCosts.provider, providerCosts.period, providerCosts.label],
          set: {
            amountCents,
            resourceId,
            metadata: {
              source: "host-configuration",
              estimated: provider === "backblaze",
              billingBasis: "monthly-not-invoice",
              observedAt: snapshot.observedAt,
            },
          },
        });
    }
    await tx
      .insert(hostInventory)
      .values({ hostname: snapshot.hostname, payload: snapshot, observedAt })
      .onConflictDoUpdate({
        target: hostInventory.hostname,
        set: { payload: snapshot, observedAt },
      });
    return {
      assetId: asset!.id,
      hostId,
      mailboxes: snapshot.mailboxes.length,
      containers: snapshot.containers.length,
      costsComplete: snapshot.hostMonthlyCents != null && snapshot.backupMonthlyCents != null,
    };
  });
  await scheduleAsset(result.assetId, 900);
  await persistCheckResult(result.assetId, summarizeHost(snapshot));
  await refreshAutoAllocations(period);
  return result;
}

export async function retireInfrastructure(
  resourceIds: string[],
  assetIds: string[],
  actor: string,
  reason: string,
) {
  await setResourceStatus({ resourceIds, status: "decommissioned", actor });
  if (assetIds.length)
    await db.update(assets).set({ enabled: false }).where(inArray(assets.id, assetIds));
  for (const id of assetIds) {
    await unscheduleAsset(id);
    await unscheduleMailPoll(id);
  }
  if (assetIds.length) {
    await db
      .update(incidents)
      .set({ endedAt: new Date(), note: `Außer Betrieb: ${reason}` })
      .where(and(inArray(incidents.assetId, assetIds), isNull(incidents.endedAt)));
    await db.update(mailboxes).set({ active: false }).where(inArray(mailboxes.assetId, assetIds));
    await db
      .update(mailDomains)
      .set({ active: false })
      .where(inArray(mailDomains.assetId, assetIds));
  }
  return { resourcesRetired: resourceIds.length, checksDisabled: assetIds.length };
}
