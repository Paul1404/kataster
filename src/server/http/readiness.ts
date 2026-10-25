import { Redis } from "ioredis";
import { Pool } from "pg";

// Bound readiness queries without imposing a timeout on business queries.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 3_000,
  query_timeout: 2_000,
  idleTimeoutMillis: 5_000,
});
pool.on("error", () => {});

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
