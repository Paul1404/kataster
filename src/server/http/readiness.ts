import { Redis } from "ioredis";
import { pool } from "../db";

export async function checkDependencies(): Promise<void> {
  // A dedicated bounded connection cannot queue probes behind worker commands.
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  try {
    await Promise.all([pool.query("SELECT 1"), redis.connect().then(() => redis.ping())]);
  } finally {
    redis.disconnect();
  }
}
