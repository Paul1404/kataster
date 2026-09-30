import { redisConnection } from "./connection";

// The worker writes a timestamp here periodically; the app reads it to tell
// whether the check worker is alive (and therefore whether green is trustworthy).
const WORKER_HEARTBEAT_KEY = "lfio:worker:heartbeat";

export async function writeWorkerHeartbeat(at: number = Date.now()): Promise<void> {
  await redisConnection.set(WORKER_HEARTBEAT_KEY, String(at));
}

export async function readWorkerHeartbeat(): Promise<number | null> {
  const raw = await redisConnection.get(WORKER_HEARTBEAT_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
