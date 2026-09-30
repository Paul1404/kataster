import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const MAIL_POLL_QUEUE = "mail-poll";

export interface MailPollJobData {
  assetId: string;
}

// Dedicated fast queue for polling mailcow rspamd history (~10s), kept separate
// from the 60s asset-check queue so its cadence and worker concurrency are isolated.
export const mailPollQueue = new Queue<MailPollJobData>(MAIL_POLL_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
    attempts: 1,
  },
});
