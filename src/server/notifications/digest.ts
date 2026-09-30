/**
 * Daily notification digest. Runs on the existing maintenance queue, so nothing
 * new polls anything: once a day the worker reads the state Kataster already
 * has (expiring domains and certificates, worker heartbeat, billing readiness)
 * and sends whatever the rules ask for. Incidents do not wait for the digest;
 * they are sent from the incident path in real time.
 *
 * Server-only.
 */
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { loadReadiness } from "../billing/service";
import { periodOf } from "../costs/margin";
import { db } from "../db";
import { domains } from "../db/schema/aws";
import { certificates } from "../db/schema/certs";
import { readWorkerHeartbeat } from "../queue/heartbeat";
import { deliverEvents } from "./deliver";
import {
  buildNotificationEvents,
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  type ExpiringItemInput,
  type NotificationRuleInput,
  type NotificationState,
  WORKER_DEAD_AFTER_MS,
} from "./events";
import { loadActiveRules } from "./rules";

const DAY_MS = 86_400_000;
const DIGEST_KINDS = ["expiry_soon", "worker_down", "billing_incomplete"] as const;

/** Widest expiry window any enabled rule asks for. */
function maxThresholdDays(rules: NotificationRuleInput[]): number {
  const thresholds = rules
    .filter((r) => r.kind === "expiry_soon")
    .map((r) => r.thresholdDays ?? DEFAULT_EXPIRY_THRESHOLD_DAYS);
  return thresholds.length > 0 ? Math.max(...thresholds) : 0;
}

async function loadExpiring(now: Date, withinDays: number): Promise<ExpiringItemInput[]> {
  if (withinDays <= 0) return [];
  const until = new Date(now.getTime() + withinDays * DAY_MS);
  const [domainRows, certRows] = await Promise.all([
    db
      .select({ name: domains.name, expiresAt: domains.registryExpiresAt })
      .from(domains)
      .where(
        and(
          eq(domains.registered, true),
          eq(domains.decommissioned, false),
          isNotNull(domains.registryExpiresAt),
          lte(domains.registryExpiresAt, until),
        ),
      ),
    db
      .select({ name: certificates.commonName, expiresAt: certificates.notAfter })
      .from(certificates)
      .where(and(isNotNull(certificates.notAfter), lte(certificates.notAfter, until))),
  ]);
  const items: ExpiringItemInput[] = [];
  for (const row of domainRows) {
    if (row.expiresAt) items.push({ kind: "domain", name: row.name, expiresAt: row.expiresAt });
  }
  for (const row of certRows) {
    if (row.expiresAt) {
      items.push({ kind: "certificate", name: row.name, expiresAt: row.expiresAt });
    }
  }
  return items;
}

/** Read everything the digest rules can reason about. */
export async function loadDigestState(
  now: Date,
  rules: NotificationRuleInput[],
): Promise<NotificationState> {
  const wantsBilling = rules.some((r) => r.kind === "billing_incomplete");
  const wantsWorker = rules.some((r) => r.kind === "worker_down");

  const [expiring, heartbeat, readiness] = await Promise.all([
    loadExpiring(now, maxThresholdDays(rules)),
    // An unreachable Redis reads as "no heartbeat", which is the honest answer:
    // without Redis the worker cannot receive jobs either.
    wantsWorker ? readWorkerHeartbeat().catch(() => null) : Promise.resolve(null),
    wantsBilling ? loadReadiness(periodOf(now)) : Promise.resolve(null),
  ]);

  return {
    now,
    openIncidents: [],
    resolvedIncidents: [],
    expiring,
    workerLastSeenAt: heartbeat ? new Date(heartbeat) : null,
    workerDeadAfterMs: WORKER_DEAD_AFTER_MS,
    billing: readiness
      ? {
          period: readiness.period,
          ready: readiness.ready,
          unassignedCount: readiness.unassigned.length,
          unassignedCostCents: readiness.unassignedCostCents,
          unpricedCount: readiness.unpriced.length,
        }
      : null,
  };
}

export interface DigestResult {
  evaluated: number;
  sent: number;
  duplicates: number;
  failed: number;
}

/** Evaluate the digest rules once and deliver what is new. Never throws. */
export async function runNotificationDigest(now: Date = new Date()): Promise<DigestResult> {
  const rules = await loadActiveRules([...DIGEST_KINDS]);
  if (rules.length === 0) return { evaluated: 0, sent: 0, duplicates: 0, failed: 0 };

  const state = await loadDigestState(now, rules);
  const events = buildNotificationEvents(state, rules);
  const outcomes = await deliverEvents(events);

  return {
    evaluated: events.length,
    sent: outcomes.filter((o) => o.status === "sent").length,
    duplicates: outcomes.filter((o) => o.status === "duplicate").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
  };
}
