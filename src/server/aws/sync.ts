import { and, eq, notInArray, sql } from "drizzle-orm";
import type { CheckResult } from "../connectors/types";
import { db } from "../db";
import { domains, webDistributions } from "../db/schema/aws";

interface Finding {
  severity: string;
  code: string;
  zone: string;
}

/**
 * Drop registry findings (auto-renew off, transfer lock off, expiring) for domains
 * the operator marked decommissioned, and clear the resulting degraded status when
 * nothing real is left. Mutates the check result in place before it is persisted.
 */
export async function suppressDecommissionedFindings(
  assetId: string,
  result: CheckResult,
): Promise<void> {
  const findings = result.raw.findings;
  if (!Array.isArray(findings) || findings.length === 0) return;
  const decom = await db
    .select({ name: domains.name })
    .from(domains)
    .where(and(eq(domains.assetId, assetId), eq(domains.decommissioned, true)));
  if (decom.length === 0) return;
  const names = new Set(decom.map((d) => d.name.toLowerCase()));

  const kept = (findings as Finding[]).filter(
    (f) =>
      !(
        typeof f?.code === "string" &&
        f.code.startsWith("registry_") &&
        names.has(String(f?.zone).toLowerCase())
      ),
  );
  if (kept.length === findings.length) return;

  result.raw.findings = kept;
  const crit = kept.filter((f) => f.severity === "critical").length;
  const warn = kept.filter((f) => f.severity === "warning").length;
  result.raw.findingCounts = { critical: crit, warning: warn, info: kept.length - crit - warn };
  // Only ever upgrade degraded -> up (a real service failure stays down/degraded).
  const serviceFailed = kept.some((f) => typeof f.code === "string" && f.code.endsWith("_failed"));
  if (result.status === "degraded" && crit === 0 && warn === 0 && !serviceFailed) {
    result.status = "up";
  }
}

interface ZoneRaw {
  name: string;
  zoneId: string;
  private?: boolean;
  recordCount?: number;
  dnssecEnabled?: boolean | null;
  findings?: unknown[];
}
interface RegistryRaw {
  name: string;
  registrar: string | null;
  expiresAt: string | null;
  autoRenew: boolean | null;
  transferLock: boolean | null;
}
interface SesRaw {
  name: string;
  type: string;
  verified: boolean;
  sendingEnabled: boolean;
}
interface WebRaw {
  distributionId: string;
  aliases: string[];
  primaryAlias: string | null;
  originDomain: string | null;
  behavior: "serve" | "redirect";
  enabled: boolean;
  status: string | null;
}

type DomainRow = typeof domains.$inferInsert;
type WebRow = typeof webDistributions.$inferInsert;

export interface MergedInventory {
  domainRows: DomainRow[];
  webRows: WebRow[];
  hasDns: boolean;
  hasRegistry: boolean;
  hasSes: boolean;
  hasWeb: boolean;
}

/**
 * Pure: fold the AWS check `raw` into upsertable rows. A block (zones/registry/
 * ses/web) is only present when its service call succeeded, so each present block
 * is the account-complete truth for that service. Domains are merged into one row
 * per name across DNS + registry + SES. No DB access -- see syncAwsInventory.
 */
export function mergeAwsInventory(assetId: string, raw: Record<string, unknown>): MergedInventory {
  const zoneList = (raw.zones as { list?: ZoneRaw[] } | undefined)?.list;
  const registryList = (raw.registry as { list?: RegistryRaw[] } | undefined)?.list;
  const sesBlock = raw.ses as { region?: string; list?: SesRaw[] } | undefined;
  const sesList = sesBlock?.list;
  const webList = (raw.web as { list?: WebRaw[] } | undefined)?.list;

  const hasDns = Array.isArray(zoneList);
  const hasRegistry = Array.isArray(registryList);
  const hasSes = Array.isArray(sesList);
  const hasWeb = Array.isArray(webList);

  const merged = new Map<string, DomainRow>();
  const ensure = (rawName: string): DomainRow => {
    const name = rawName.replace(/\.$/, "").toLowerCase();
    let row = merged.get(name);
    if (!row) {
      row = { assetId, name };
      merged.set(name, row);
    }
    return row;
  };

  if (hasDns) {
    for (const z of zoneList) {
      if (!z.name) continue;
      const row = ensure(z.name);
      row.hostedZoneId = z.zoneId ?? null;
      row.isPrivateZone = z.private ?? false;
      row.recordCount = z.recordCount ?? null;
      row.dnssecEnabled = z.dnssecEnabled ?? null;
      row.findingCount = Array.isArray(z.findings) ? z.findings.length : 0;
    }
  }
  if (hasRegistry) {
    for (const d of registryList) {
      if (!d.name) continue;
      const row = ensure(d.name);
      row.registered = true;
      row.registrar = d.registrar ?? null;
      row.registryExpiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
      row.autoRenew = d.autoRenew ?? null;
      row.transferLock = d.transferLock ?? null;
    }
  }
  if (hasSes) {
    const region = sesBlock?.region ?? null;
    for (const s of sesList) {
      if (s.type !== "DOMAIN" || !s.name) continue;
      const row = ensure(s.name);
      row.sesVerified = s.verified;
      row.sesSendingEnabled = s.sendingEnabled;
      row.sesRegion = region;
    }
  }

  const webRows: WebRow[] = hasWeb
    ? webList
        .filter((w) => w.distributionId)
        .map((w) => ({
          assetId,
          distributionId: w.distributionId,
          aliases: w.aliases ?? [],
          primaryAlias: w.primaryAlias ?? null,
          originDomain: w.originDomain ?? null,
          behavior: w.behavior,
          enabled: w.enabled,
          status: w.status ?? null,
        }))
    : [];

  return { domainRows: [...merged.values()], webRows, hasDns, hasRegistry, hasSes, hasWeb };
}

/**
 * Reconcile the domains and web_distributions tables with the latest AWS check.
 * Upserts only the column groups whose block ran this check -- a service that
 * failed (or is toggled off) never nulls out another service's columns. Prune
 * runs only when the structural sources (DNS + registry) both ran, so a transient
 * API hiccup can't wipe customer assignments. customerId is never overwritten.
 */
export async function syncAwsInventory(
  assetId: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const { domainRows, webRows, hasDns, hasRegistry, hasSes, hasWeb } = mergeAwsInventory(
    assetId,
    raw,
  );

  if (hasDns || hasRegistry || hasSes) {
    const rows = domainRows;
    if (rows.length > 0) {
      // Only refresh column groups whose block ran; customerId is never set.
      const set: Record<string, unknown> = { lastSeenAt: sql`excluded.last_seen_at` };
      if (hasDns) {
        set.hostedZoneId = sql`excluded.hosted_zone_id`;
        set.isPrivateZone = sql`excluded.is_private_zone`;
        set.recordCount = sql`excluded.record_count`;
        set.dnssecEnabled = sql`excluded.dnssec_enabled`;
        set.findingCount = sql`excluded.finding_count`;
      }
      if (hasRegistry) {
        set.registered = sql`excluded.registered`;
        set.registrar = sql`excluded.registrar`;
        set.registryExpiresAt = sql`excluded.registry_expires_at`;
        set.autoRenew = sql`excluded.auto_renew`;
        set.transferLock = sql`excluded.transfer_lock`;
      }
      if (hasSes) {
        set.sesVerified = sql`excluded.ses_verified`;
        set.sesSendingEnabled = sql`excluded.ses_sending_enabled`;
        set.sesRegion = sql`excluded.ses_region`;
      }
      await db
        .insert(domains)
        .values(rows)
        .onConflictDoUpdate({ target: [domains.assetId, domains.name], set });

      // Prune only with a complete structural picture (DNS + registry both ran).
      if (hasDns && hasRegistry) {
        await db.delete(domains).where(
          and(
            eq(domains.assetId, assetId),
            notInArray(
              domains.name,
              rows.map((r) => r.name),
            ),
          ),
        );
      }
    }
  }

  if (hasWeb) {
    const rows = webRows;
    if (rows.length > 0) {
      await db
        .insert(webDistributions)
        .values(rows)
        .onConflictDoUpdate({
          target: [webDistributions.assetId, webDistributions.distributionId],
          set: {
            aliases: sql`excluded.aliases`,
            primaryAlias: sql`excluded.primary_alias`,
            originDomain: sql`excluded.origin_domain`,
            behavior: sql`excluded.behavior`,
            enabled: sql`excluded.enabled`,
            status: sql`excluded.status`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      await db.delete(webDistributions).where(
        and(
          eq(webDistributions.assetId, assetId),
          notInArray(
            webDistributions.distributionId,
            rows.map((r) => r.distributionId),
          ),
        ),
      );
    }
  }

  await autoMapByName(assetId);
}

/**
 * Fill in unassigned customers by matching domain names. Assigning one capability
 * of a customer domain (e.g. its mailcow mail) auto-places the rest.
 */
async function autoMapByName(assetId: string): Promise<void> {
  // domains <- mail_domains (mailcow) by name
  await db.execute(sql`
    update domains d
    set customer_id = m.customer_id
    from mail_domains m
    where d.asset_id = ${assetId}
      and d.customer_id is null
      and m.customer_id is not null
      and lower(m.name) = d.name
  `);
  // web_distributions <- domains by primary alias
  await db.execute(sql`
    update web_distributions w
    set customer_id = d.customer_id
    from domains d
    where w.asset_id = ${assetId}
      and w.customer_id is null
      and d.customer_id is not null
      and d.name = w.primary_alias
  `);
}
