import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { certificates } from "../db/schema/certs";

export type CertSource = "tls" | "acm";

export interface CertInput {
  commonName: string;
  sans?: string[];
  issuer?: string | null;
  notAfter?: string | null;
}

type CertRow = typeof certificates.$inferInsert;

/** Pure: normalize observed certs into upsertable rows (lowercased CN, Date notAfter). */
export function buildCertRows(assetId: string, source: CertSource, list: CertInput[]): CertRow[] {
  const byCn = new Map<string, CertRow>();
  for (const c of list) {
    const commonName = (c.commonName ?? "").replace(/\.$/, "").toLowerCase();
    if (!commonName) continue;
    byCn.set(commonName, {
      assetId,
      source,
      commonName,
      sans: (c.sans ?? []).map((s) => s.replace(/\.$/, "").toLowerCase()),
      issuer: c.issuer ?? null,
      notAfter: c.notAfter ? new Date(c.notAfter) : null,
    });
  }
  return [...byCn.values()];
}

/**
 * Reconcile the certificates table for one asset + source. Upserts current certs,
 * prunes ones no longer seen (skipped on empty so a hiccup can't wipe rows), and
 * auto-maps each cert to a customer by common name (or the asset's own location).
 * customerId is never overwritten once set.
 */
export async function syncCertificates(
  assetId: string,
  source: CertSource,
  list: CertInput[],
): Promise<void> {
  const rows = buildCertRows(assetId, source, list);
  if (rows.length === 0) return;

  await db
    .insert(certificates)
    .values(rows)
    .onConflictDoUpdate({
      target: [certificates.assetId, certificates.source, certificates.commonName],
      set: {
        sans: sql`excluded.sans`,
        issuer: sql`excluded.issuer`,
        notAfter: sql`excluded.not_after`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });

  await db.delete(certificates).where(
    and(
      eq(certificates.assetId, assetId),
      eq(certificates.source, source),
      notInArray(
        certificates.commonName,
        rows.map((r) => r.commonName),
      ),
    ),
  );

  // Auto-map unassigned certs to a customer: by domain name, then by the asset's
  // own location (a placed http asset belongs to the customer it serves).
  await db.execute(sql`
    update certificates c
    set customer_id = d.customer_id
    from domains d
    where c.asset_id = ${assetId}
      and c.customer_id is null
      and d.customer_id is not null
      and d.name = c.common_name
  `);
  await db.execute(sql`
    update certificates c
    set customer_id = m.customer_id
    from mail_domains m
    where c.asset_id = ${assetId}
      and c.customer_id is null
      and m.customer_id is not null
      and lower(m.name) = c.common_name
  `);
  await db.execute(sql`
    update certificates c
    set customer_id = a.customer_id
    from assets a
    where c.id in (select id from certificates where asset_id = ${assetId} and customer_id is null)
      and a.id = ${assetId}
      and a.customer_id is not null
      and c.asset_id = ${assetId}
      and c.customer_id is null
  `);
}
