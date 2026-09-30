import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { mailboxes, mailDomains } from "../db/schema/mail";

interface RawDomain {
  name: string;
  active: boolean;
  mailboxes: number;
  aliases: number;
  storageBytes: number;
  messages: number;
}

interface RawMailbox {
  address: string;
  domain: string;
  name: string | null;
  active: boolean;
  quotaBytes: number;
  quotaUsedBytes: number;
  messages: number;
}

/**
 * Reconcile the mail_domains and mailboxes tables with the latest mailcow check.
 * Refreshes stats, keeps each row's customer assignment (customerId), and prunes
 * entities that no longer exist. Prune is skipped when a list comes back empty so
 * a transient API hiccup can't wipe assignments.
 */
export async function syncMailcowInventory(
  assetId: string,
  raw: Record<string, unknown>,
): Promise<void> {
  const domainList = (raw.domains as { list?: RawDomain[] } | undefined)?.list;
  const mailboxList = (raw.mailboxes as { list?: RawMailbox[] } | undefined)?.list;

  if (Array.isArray(domainList) && domainList.length > 0) {
    const rows = domainList
      .filter((d) => d.name)
      .map((d) => ({
        assetId,
        name: d.name,
        active: d.active,
        mailboxCount: Math.round(d.mailboxes),
        aliasCount: Math.round(d.aliases),
        storageBytes: d.storageBytes,
        messages: d.messages,
      }));
    if (rows.length > 0) {
      await db
        .insert(mailDomains)
        .values(rows)
        .onConflictDoUpdate({
          target: [mailDomains.assetId, mailDomains.name],
          set: {
            active: sql`excluded.active`,
            mailboxCount: sql`excluded.mailbox_count`,
            aliasCount: sql`excluded.alias_count`,
            storageBytes: sql`excluded.storage_bytes`,
            messages: sql`excluded.messages`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      await db.delete(mailDomains).where(
        and(
          eq(mailDomains.assetId, assetId),
          notInArray(
            mailDomains.name,
            rows.map((r) => r.name),
          ),
        ),
      );
    }
  }

  if (Array.isArray(mailboxList) && mailboxList.length > 0) {
    const rows = mailboxList
      .filter((m) => m.address)
      .map((m) => ({
        assetId,
        domainName: m.domain,
        address: m.address,
        name: m.name,
        active: m.active,
        quotaBytes: m.quotaBytes,
        quotaUsedBytes: m.quotaUsedBytes,
        messages: m.messages,
      }));
    if (rows.length > 0) {
      await db
        .insert(mailboxes)
        .values(rows)
        .onConflictDoUpdate({
          target: [mailboxes.assetId, mailboxes.address],
          set: {
            domainName: sql`excluded.domain_name`,
            name: sql`excluded.name`,
            active: sql`excluded.active`,
            quotaBytes: sql`excluded.quota_bytes`,
            quotaUsedBytes: sql`excluded.quota_used_bytes`,
            messages: sql`excluded.messages`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
        });
      await db.delete(mailboxes).where(
        and(
          eq(mailboxes.assetId, assetId),
          notInArray(
            mailboxes.address,
            rows.map((r) => r.address),
          ),
        ),
      );
    }
  }
}
