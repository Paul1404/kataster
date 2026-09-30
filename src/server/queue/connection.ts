import { Redis } from "ioredis";

// Shared Redis connection for BullMQ. maxRetriesPerRequest must be null for
// BullMQ blocking commands.
export const redisConnection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
