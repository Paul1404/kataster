/**
 * Kataster check worker. Runs scheduled connector probes and writes results to
 * Postgres. Deployed as a separate Railway service using the same image with a
 * different start command (bun run src/worker/index.ts).
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { suppressDecommissionedFindings, syncAwsInventory } from "../server/aws/sync";
import { applyOwnerSuggestions } from "../server/billing/service";
import { type CertInput, syncCertificates } from "../server/certs/sync";
import { persistCheckResult } from "../server/checks/persist";
import { recordProjectionFailure, recordProjectionSuccess } from "../server/checks/projection";
import { compactCheckResults } from "../server/checks/retention";
import { loadConnectionSecret } from "../server/connections/service";
import { requireConnector } from "../server/connectors/registry";
import type { CheckResult } from "../server/connectors/types";
import { refreshAutoAllocations } from "../server/costs/auto-allocate";
import { ingestAwsCost, ingestRailwayCost, shouldRefreshAwsCost } from "../server/costs/ingest";
import { periodOf } from "../server/costs/margin";
import { assertEncryptionKey } from "../server/crypto/secrets";
import { db } from "../server/db";
import { assets } from "../server/db/schema/assets";
import { readMailCursor, writeMailCursor } from "../server/mail/cursor";
import { pruneMailEvents, syncMailEvents } from "../server/mail/events-sync";
import { fetchRspamdHistory } from "../server/mail/rspamd";
import { syncMailcowInventory } from "../server/mail/sync";
import { runNotificationDigest } from "../server/notifications/digest";
import { CHECKS_QUEUE, type CheckJobData } from "../server/queue/checks.queue";
import { redisConnection } from "../server/queue/connection";
import { writeWorkerHeartbeat } from "../server/queue/heartbeat";
import { MAIL_POLL_QUEUE, type MailPollJobData } from "../server/queue/mail-poll.queue";
import {
  MAINTENANCE_QUEUE,
  type MaintenanceJobData,
  scheduleDataMaintenance,
} from "../server/queue/maintenance.queue";
import { pruneStaleCIs } from "../server/resources/ci";
import {
  syncAwsResources,
  syncHetznerCloudResources,
  syncMailResources,
  syncRailwayResources,
} from "../server/resources/sync";
import { syncSsmInventory } from "../server/ssm/sync";
import { reconcileSchedulers } from "./reconcile";

// The production workload has only a few dozen schedules. Keeping concurrency
// modest prevents several metadata-heavy connector runs from overlapping and
// retaining hundreds of megabytes without delaying normal one-minute checks.
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const MAIL_POLL_CONCURRENCY = Number(process.env.MAIL_POLL_CONCURRENCY ?? 1);
// Set to "false" to stop the worker from assigning owners on its own.
const BILLING_AUTO_ASSIGN = process.env.BILLING_AUTO_ASSIGN !== "false";
const HARD_TIMEOUT_MS = 90_000;
const MAIL_POLL_TIMEOUT_MS = 15_000;
const MAIL_EVENTS_RETENTION_DAYS = Number(process.env.MAIL_EVENTS_RETENTION_DAYS ?? 7);
// Prune retention roughly once an hour (every Nth ~10s poll), not on every run.
const PRUNE_EVERY_RUNS = 360;
let mailPollRuns = 0;
// Sweep CIs/facets no source has confirmed in this long (a removed host/domain).
const CI_STALE_DAYS = 3;
const PRUNE_CI_EVERY_RUNS = 500;
let checkRuns = 0;

async function runCheck(assetId: string): Promise<void> {
  const asset = await db.query.assets.findFirst({ where: eq(assets.id, assetId) });
  if (!asset?.enabled) return;

  const connector = requireConnector(asset.connectorId);
  let config = v.parse(connector.configSchema, asset.config) as Record<string, unknown>;
  const secrets = asset.connectionId ? await loadConnectionSecret(asset.connectionId) : {};

  const checkNow = new Date();
  if (asset.connectorId === "aws" && config.pullCost) {
    // AWS Cost Explorer is billed per API call. The AWS asset itself may run every
    // minute, but cost data only needs one persistent refresh per day.
    let pullCost = false;
    try {
      pullCost = await shouldRefreshAwsCost(checkNow);
    } catch (error) {
      // Fail closed: a database read problem must never turn into paid API spam.
      console.error("[worker] AWS cost refresh gate failed", (error as Error)?.message);
    }
    config = { ...config, pullCost };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  let result: CheckResult;
  try {
    result = await connector.check(asset.target, config, secrets, {
      signal: controller.signal,
      now: checkNow,
    });
  } catch (error) {
    result = {
      status: "unknown",
      latencyMs: null,
      message: error instanceof Error ? error.message : "check threw",
      raw: {},
    };
  } finally {
    clearTimeout(timer);
  }

  // Mailcow: reconcile the domain/mailbox inventory, then drop the heavy
  // per-mailbox list so it does not bloat every retained history row.
  if (asset.connectorId === "mailcow") {
    try {
      await syncMailcowInventory(asset.id, result.raw);
      await syncMailResources(asset);
      result = recordProjectionSuccess(result, "mailcow.inventory", checkNow);
    } catch (error) {
      console.error("[worker] mailcow sync failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "mailcow.inventory", error, checkNow);
    }
    const mb = result.raw.mailboxes as { list?: unknown } | undefined;
    if (mb && "list" in mb) delete (mb as { list?: unknown }).list;
  }

  // AWS: reconcile the normalized domain/CloudFront/cert inventory, then drop the
  // heavy per-service lists so they do not bloat every retained history row.
  if (asset.connectorId === "aws") {
    try {
      await syncAwsInventory(asset.id, result.raw);
      const certs = (result.raw.certs as { list?: CertInput[] } | undefined)?.list;
      if (Array.isArray(certs)) await syncCertificates(asset.id, "acm", certs);
      // Project the synced typed inventory (+ SES tenants) into the resources table.
      await syncAwsResources(asset, result.raw);
      // Drop findings for decommissioned domains (and clear a now-clean status).
      await suppressDecommissionedFindings(asset.id, result);
      // Optional: roll month-to-date AWS spend into a metered cost pool.
      await ingestAwsCost(result.raw);
      result = recordProjectionSuccess(result, "aws.inventory-and-cost", checkNow);
    } catch (error) {
      console.error("[worker] aws sync failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "aws.inventory-and-cost", error, checkNow);
    }
    for (const key of ["zones", "registry", "web", "ses", "tenants", "certs"]) {
      const block = result.raw[key] as { list?: unknown } | undefined;
      if (block && "list" in block) delete (block as { list?: unknown }).list;
    }
  }

  // SSM: reconcile managed-node patch state + patch history, then drop the heavy
  // per-node patch lists so they do not bloat retained check history.
  if (asset.connectorId === "ssm") {
    try {
      await syncSsmInventory(asset, result.raw);
      result = recordProjectionSuccess(result, "ssm.inventory", checkNow);
    } catch (error) {
      console.error("[worker] ssm sync failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "ssm.inventory", error, checkNow);
    }
    const hb = result.raw.hosts as { list?: unknown } | undefined;
    if (hb && "list" in hb) delete (hb as { list?: unknown }).list;
  }

  // Hetzner Cloud: enrich host CIs with hardware + monthly price, and upsert a
  // per-host cost pool, then drop the heavy server list.
  if (asset.connectorId === "hetzner-cloud") {
    try {
      await syncHetznerCloudResources(asset, result.raw);
      result = recordProjectionSuccess(result, "hetzner-cloud.inventory-and-cost", checkNow);
    } catch (error) {
      console.error("[worker] hetzner-cloud sync failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "hetzner-cloud.inventory-and-cost", error, checkNow);
    }
    const sb = result.raw.servers as { list?: unknown } | undefined;
    if (sb && "list" in sb) delete (sb as { list?: unknown }).list;
  }

  // Railway: project projects + services into resources, then roll estimated
  // per-project spend into cost pools; finally drop the heavy list.
  if (asset.connectorId === "railway") {
    try {
      await syncRailwayResources(asset, result.raw);
      await ingestRailwayCost(result.raw);
      result = recordProjectionSuccess(result, "railway.inventory-and-cost", checkNow);
    } catch (error) {
      console.error("[worker] railway sync failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "railway.inventory-and-cost", error, checkNow);
    }
    const pb = result.raw.projects as { list?: unknown } | undefined;
    if (pb && "list" in pb) delete (pb as { list?: unknown }).list;
  }

  // HTTP: persist the observed TLS certificate for the expiry view.
  if (asset.connectorId === "http") {
    const cert = result.raw.certificate as CertInput | undefined;
    if (cert?.commonName) {
      try {
        await syncCertificates(asset.id, "tls", [cert]);
        result = recordProjectionSuccess(result, "tls.certificate", checkNow);
      } catch (error) {
        console.error("[worker] tls cert sync failed", asset.id, (error as Error)?.message);
        result = recordProjectionFailure(result, "tls.certificate", error, checkNow);
      }
    }
  }

  // Auto cost allocation: whenever a cost-relevant provider re-syncs, its pools or
  // usage weights may have moved, so refresh the usage-weighted allocations for the
  // current period. Idempotent and preserves manual allocations.
  if (
    asset.connectorId === "aws" ||
    asset.connectorId === "hetzner-cloud" ||
    asset.connectorId === "railway"
  ) {
    try {
      // Close the attribution loop: a resource discovered before its domain or
      // parent got an owner picks that owner up now. High-confidence only; name
      // matches stay a suggestion for the billing page.
      if (BILLING_AUTO_ASSIGN) {
        const applied = await applyOwnerSuggestions({ minConfidence: "high", actor: "worker" });
        for (const a of applied) {
          console.log(`[worker] assigned ${a.resourceName} to ${a.customerName} (${a.reason})`);
        }
      }
      await refreshAutoAllocations(periodOf(new Date()));
      result = recordProjectionSuccess(result, "cost.allocation", checkNow);
    } catch (error) {
      console.error("[worker] auto-allocate failed", asset.id, (error as Error)?.message);
      result = recordProjectionFailure(result, "cost.allocation", error, checkNow);
    }
  }

  await persistCheckResult(assetId, result);
  await writeWorkerHeartbeat().catch(() => {});

  // Periodic sweep of CIs/facets that no source has confirmed recently (a host or
  // domain removed upstream). Runs rarely, off the check cadence.
  checkRuns += 1;
  if (checkRuns % PRUNE_CI_EVERY_RUNS === 0) {
    await pruneStaleCIs(new Date(Date.now() - CI_STALE_DAYS * 86_400_000)).catch((error) =>
      console.error("[worker] prune stale CIs failed", (error as Error)?.message),
    );
  }
}

// Poll a mailcow server's rspamd history for new mail events and persist them.
// The Redis cursor makes the first poll seed from "now" (no backlog burst); later
// polls ingest only events newer than the cursor.
async function runMailPoll(assetId: string): Promise<void> {
  const asset = await db.query.assets.findFirst({ where: eq(assets.id, assetId) });
  if (!asset?.enabled || asset.connectorId !== "mailcow" || !asset.connectionId) return;

  const secrets = await loadConnectionSecret(asset.connectionId);
  const apiKey = typeof secrets.apiKey === "string" ? secrets.apiKey : "";
  if (!apiKey) return;

  const records = await fetchRspamdHistory(
    asset.target,
    apiKey,
    AbortSignal.timeout(MAIL_POLL_TIMEOUT_MS),
  );
  if (records.length === 0) return;

  const cursor = await readMailCursor(assetId);
  if (cursor == null) {
    // Cold start: seed the cursor to the newest record, ingest nothing.
    const newest = records.reduce((m, r) => Math.max(m, r.occurredAtMs), 0);
    await writeMailCursor(assetId, newest);
    return;
  }

  const { inserted, overflow, maxOccurredAtMs } = await syncMailEvents(assetId, records, cursor);
  if (maxOccurredAtMs > cursor) await writeMailCursor(assetId, maxOccurredAtMs);
  if (overflow > 0) {
    console.warn(`[worker] mail poll ${assetId}: capped ${overflow} extra recipient(s)`);
  }
  if (inserted > 0) {
    console.log(`[worker] mail poll ${assetId}: ingested ${inserted} event(s)`);
  }

  mailPollRuns += 1;
  if (mailPollRuns % PRUNE_EVERY_RUNS === 0) {
    const removed = await pruneMailEvents(MAIL_EVENTS_RETENTION_DAYS);
    if (removed > 0) console.log(`[worker] pruned ${removed} old mail event(s)`);
  }
}

async function main() {
  assertEncryptionKey();
  await reconcileSchedulers();
  await scheduleDataMaintenance();

  // Liveness beacon: write now and every 15s, so the app can detect a dead worker
  // even when no checks are running.
  await writeWorkerHeartbeat().catch(() => {});
  const heartbeat = setInterval(() => {
    writeWorkerHeartbeat().catch(() => {});
  }, 15_000);
  heartbeat.unref?.();

  const worker = new Worker<CheckJobData>(CHECKS_QUEUE, (job) => runCheck(job.data.assetId), {
    connection: redisConnection,
    concurrency: CONCURRENCY,
  });

  worker.on("failed", (job, err) => {
    console.error("[worker] check failed", job?.data.assetId, err?.message);
  });
  worker.on("ready", () => {
    console.log(`[worker] listening on "${CHECKS_QUEUE}", concurrency=${CONCURRENCY}`);
  });

  const mailWorker = new Worker<MailPollJobData>(
    MAIL_POLL_QUEUE,
    (job) => runMailPoll(job.data.assetId),
    { connection: redisConnection, concurrency: MAIL_POLL_CONCURRENCY },
  );

  mailWorker.on("failed", (job, err) => {
    console.error("[worker] mail poll failed", job?.data.assetId, err?.message);
  });
  mailWorker.on("ready", () => {
    console.log(`[worker] listening on "${MAIL_POLL_QUEUE}", concurrency=${MAIL_POLL_CONCURRENCY}`);
  });

  const maintenanceWorker = new Worker<MaintenanceJobData>(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.data.task === "notification-digest") {
        const digest = await runNotificationDigest();
        console.log(
          `[worker] notification digest: ${digest.evaluated} event(s) evaluated, ${digest.sent} sent, ${digest.duplicates} already known, ${digest.failed} failed`,
        );
        return;
      }
      if (job.data.task !== "compact-check-results") return;
      const result = await compactCheckResults();
      console.log(
        `[worker] compacted check history before ${result.cutoff.toISOString()}, removed ${result.deleted} raw row(s)`,
      );
    },
    { connection: redisConnection, concurrency: 1 },
  );
  maintenanceWorker.on("failed", (_job, error) => {
    console.error("[worker] data maintenance failed", error.message);
  });
  maintenanceWorker.on("ready", () => {
    console.log(`[worker] listening on "${MAINTENANCE_QUEUE}", concurrency=1`);
  });

  const shutdown = async () => {
    console.log("[worker] shutting down");
    await Promise.all([worker.close(), mailWorker.close(), maintenanceWorker.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
