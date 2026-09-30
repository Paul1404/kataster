import { checksQueue } from "./checks.queue";
import { mailPollQueue } from "./mail-poll.queue";

const MIN_INTERVAL_SECONDS = 5;

// How often to poll a mailcow server's rspamd history for new mail events.
const MAIL_POLL_INTERVAL_MS = Math.max(Number(process.env.MAIL_POLL_INTERVAL_MS ?? 10_000), 3_000);

/** Create or update the repeatable check job for an asset (idempotent by id). */
export async function scheduleAsset(assetId: string, intervalSeconds: number): Promise<void> {
  const every = Math.max(intervalSeconds, MIN_INTERVAL_SECONDS) * 1000;
  await checksQueue.upsertJobScheduler(
    `asset:${assetId}`,
    { every },
    { name: "check", data: { assetId } },
  );
}

/** Remove an asset's repeatable check job. Safe if none exists. */
export async function unscheduleAsset(assetId: string): Promise<void> {
  await checksQueue.removeJobScheduler(`asset:${assetId}`);
}

/** Create or update the fast rspamd-history poll for a mailcow asset (idempotent). */
export async function scheduleMailPoll(assetId: string): Promise<void> {
  await mailPollQueue.upsertJobScheduler(
    `mailpoll:${assetId}`,
    { every: MAIL_POLL_INTERVAL_MS },
    { name: "poll", data: { assetId } },
  );
}

/** Remove a mailcow asset's mail-poll job. Safe if none exists. */
export async function unscheduleMailPoll(assetId: string): Promise<void> {
  await mailPollQueue.removeJobScheduler(`mailpoll:${assetId}`);
}
