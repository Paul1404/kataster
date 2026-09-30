import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const MAINTENANCE_QUEUE = "data-maintenance";
export const CHECK_RETENTION_SCHEDULER = "check-results-retention";
export const NOTIFICATION_DIGEST_SCHEDULER = "notification-digest";

export interface MaintenanceJobData {
  task: "compact-check-results" | "notification-digest";
}

export const maintenanceQueue = new Queue<MaintenanceJobData>(MAINTENANCE_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
  },
});

export async function scheduleDataMaintenance(): Promise<void> {
  await maintenanceQueue.upsertJobScheduler(
    CHECK_RETENTION_SCHEDULER,
    { every: 24 * 60 * 60 * 1000 },
    { name: "compact-check-results", data: { task: "compact-check-results" } },
  );
  // Slow signals (expiry, dead worker, incomplete billing month) are evaluated
  // once a day on this existing queue. Incidents notify in real time instead.
  // A fixed time of day, not "every 24h from boot": with an interval the digest
  // drifts with every deploy and can land at night.
  await maintenanceQueue.upsertJobScheduler(
    NOTIFICATION_DIGEST_SCHEDULER,
    { pattern: "15 7 * * *" },
    { name: "notification-digest", data: { task: "notification-digest" } },
  );
}
