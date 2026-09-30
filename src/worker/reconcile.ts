import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { assets } from "../server/db/schema/assets";
import { checksQueue } from "../server/queue/checks.queue";
import { mailPollQueue } from "../server/queue/mail-poll.queue";
import { scheduleAsset, scheduleMailPoll } from "../server/queue/schedule";

/**
 * Reconcile BullMQ job schedulers with the database on worker boot. Postgres is
 * the source of truth: schedule every enabled asset and drop any
 * scheduler that no longer maps to one (e.g. after a Redis wipe or asset delete).
 */
export async function reconcileSchedulers(): Promise<void> {
  const rows = await db
    .select({
      id: assets.id,
      intervalSeconds: assets.intervalSeconds,
      connectorId: assets.connectorId,
    })
    .from(assets)
    .where(eq(assets.enabled, true));

  const wanted = new Set<string>();
  const wantedMail = new Set<string>();
  for (const asset of rows) {
    wanted.add(`asset:${asset.id}`);
    await scheduleAsset(asset.id, asset.intervalSeconds);
    if (asset.connectorId === "mailcow") {
      wantedMail.add(`mailpoll:${asset.id}`);
      await scheduleMailPoll(asset.id);
    }
  }

  const existing = await checksQueue.getJobSchedulers();
  for (const scheduler of existing) {
    if (scheduler.key?.startsWith("asset:") && !wanted.has(scheduler.key)) {
      await checksQueue.removeJobScheduler(scheduler.key);
    }
  }

  const existingMail = await mailPollQueue.getJobSchedulers();
  for (const scheduler of existingMail) {
    if (scheduler.key?.startsWith("mailpoll:") && !wantedMail.has(scheduler.key)) {
      await mailPollQueue.removeJobScheduler(scheduler.key);
    }
  }

  console.log(`[worker] reconciled ${wanted.size} scheduler(s), ${wantedMail.size} mail poll(s)`);
}
