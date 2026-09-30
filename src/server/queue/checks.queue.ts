import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const CHECKS_QUEUE = "asset-checks";

export interface CheckJobData {
  assetId: string;
}

// The web app owns only this Queue (to enqueue/reschedule). The Worker is created
// solely by the worker entrypoint.
export const checksQueue = new Queue<CheckJobData>(CHECKS_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 1,
  },
});
