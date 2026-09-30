import { eq, lt } from "drizzle-orm";
import { db } from "../db";
import { assets } from "../db/schema/assets";
import { mailDomains } from "../db/schema/mail";
import { mailEvents } from "../db/schema/mail-events";
import type { RspamdRecord } from "./rspamd";

// Cap recipients fanned out from a single message so one mailing-list blast can't
// spawn hundreds of rows. The remainder is reported as overflow, never dropped silently.
const MAX_FANOUT = 20;

export interface MailEventContext {
  /** Customer of the mailcow server asset (null if it is not placed on the map). */
  serverCustomerId: string | null;
  /** Lowercased local domain -> customer customerId (null when the domain is unplaced). */
  domainLocation: Map<string, string | null>;
}

export interface MailEventRow {
  assetId: string;
  messageId: string;
  rcptIndex: number;
  direction: "inbound" | "outbound";
  serverCustomerId: string | null;
  endpointCustomerId: string | null;
  domainName: string;
  sender: string | null;
  recipient: string | null;
  action: string | null;
  score: number | null;
  sizeBytes: number | null;
  occurredAt: Date;
}

export interface BuildResult {
  rows: MailEventRow[];
  overflow: number;
  maxOccurredAtMs: number;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0
    ? address
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : "";
}

/**
 * Pure classification: turn rspamd records into mail-event rows. Outbound when the
 * message was authenticated (or its sender domain is local); inbound for each local
 * recipient. Records at or before `sinceMs` are skipped (cursor / cold-start guard).
 */
export function buildMailEventRows(
  assetId: string,
  records: RspamdRecord[],
  ctx: MailEventContext,
  sinceMs: number,
): BuildResult {
  const rows: MailEventRow[] = [];
  let overflow = 0;
  let maxOccurredAtMs = sinceMs;

  for (const r of records) {
    if (r.occurredAtMs > maxOccurredAtMs) maxOccurredAtMs = r.occurredAtMs;
    if (r.occurredAtMs < sinceMs) continue;

    const occurredAt = new Date(r.occurredAtMs);
    const senderDomain = domainOf(r.sender);
    const userDomain = r.user ? domainOf(r.user) : "";

    // Outbound: authenticated submission, or the sender is one of our domains.
    const outboundDomain =
      ctx.domainLocation.has(senderDomain) && senderDomain
        ? senderDomain
        : r.user && ctx.domainLocation.has(userDomain)
          ? userDomain
          : "";
    if (outboundDomain) {
      rows.push({
        assetId,
        messageId: r.messageId,
        rcptIndex: 0,
        direction: "outbound",
        serverCustomerId: ctx.serverCustomerId,
        endpointCustomerId: ctx.domainLocation.get(outboundDomain) ?? null,
        domainName: outboundDomain,
        sender: r.sender || null,
        recipient: r.recipients[0] ?? null,
        action: r.action,
        score: r.score,
        sizeBytes: r.sizeBytes,
        occurredAt,
      });
    }

    // Inbound: one row per recipient that lands on one of our domains.
    let inboundIdx = 0;
    for (const rcpt of r.recipients) {
      const rcptDomain = domainOf(rcpt);
      if (!ctx.domainLocation.has(rcptDomain)) continue;
      // Don't emit an inbound row for a purely-local self-send already counted outbound.
      if (rcptDomain === outboundDomain && rcpt === r.sender) continue;
      if (inboundIdx >= MAX_FANOUT) {
        overflow += 1;
        continue;
      }
      rows.push({
        assetId,
        messageId: r.messageId,
        rcptIndex: inboundIdx,
        direction: "inbound",
        serverCustomerId: ctx.serverCustomerId,
        endpointCustomerId: ctx.domainLocation.get(rcptDomain) ?? null,
        domainName: rcptDomain,
        sender: r.sender || null,
        recipient: rcpt,
        action: r.action,
        score: r.score,
        sizeBytes: r.sizeBytes,
        occurredAt,
      });
      inboundIdx += 1;
    }
  }

  return { rows, overflow, maxOccurredAtMs };
}

async function loadContext(assetId: string): Promise<MailEventContext> {
  const [asset] = await db
    .select({ customerId: assets.customerId })
    .from(assets)
    .where(eq(assets.id, assetId));
  const domains = await db
    .select({ name: mailDomains.name, customerId: mailDomains.customerId })
    .from(mailDomains)
    .where(eq(mailDomains.assetId, assetId));
  const domainLocation = new Map<string, string | null>();
  for (const d of domains) domainLocation.set(d.name.toLowerCase(), d.customerId);
  return { serverCustomerId: asset?.customerId ?? null, domainLocation };
}

export interface SyncResult {
  inserted: number;
  overflow: number;
  maxOccurredAtMs: number;
}

/**
 * Persist new mail events for a mailcow asset. Idempotent: dedups on
 * (asset, message, recipient, direction) so overlapping poll windows never double
 * insert. Returns the newest event time so the caller can advance its cursor.
 */
export async function syncMailEvents(
  assetId: string,
  records: RspamdRecord[],
  sinceMs: number,
): Promise<SyncResult> {
  const ctx = await loadContext(assetId);
  const { rows, overflow, maxOccurredAtMs } = buildMailEventRows(assetId, records, ctx, sinceMs);
  if (rows.length === 0) return { inserted: 0, overflow, maxOccurredAtMs };

  const inserted = await db
    .insert(mailEvents)
    .values(rows)
    .onConflictDoNothing({
      target: [
        mailEvents.assetId,
        mailEvents.messageId,
        mailEvents.rcptIndex,
        mailEvents.direction,
      ],
    })
    .returning({ id: mailEvents.id });

  return { inserted: inserted.length, overflow, maxOccurredAtMs };
}

/** Drop events older than the retention window. Cheap via the occurredAt index. */
export async function pruneMailEvents(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const removed = await db
    .delete(mailEvents)
    .where(lt(mailEvents.occurredAt, cutoff))
    .returning({ id: mailEvents.id });
  return removed.length;
}
