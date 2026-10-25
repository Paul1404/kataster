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
  await maintenanceQueue.removeJobScheduler(NOTIFICATION_DIGEST_SCHEDULER);
}
