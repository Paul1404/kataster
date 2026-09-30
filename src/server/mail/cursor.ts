import { redisConnection } from "../queue/connection";

// Per-asset high-water mark (ms since epoch) of the newest mail event we've ingested.
// Kept in Redis (ephemeral, queue-local) so a fresh start begins from "now" rather
// than burst-replaying mailcow's whole rspamd-history ring.
const key = (assetId: string) => `mailpoll:cursor:${assetId}`;

export async function readMailCursor(assetId: string): Promise<number | null> {
  const val = await redisConnection.get(key(assetId));
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export async function writeMailCursor(assetId: string, occurredAtMs: number): Promise<void> {
  // 30-day TTL: a long-idle asset re-seeds from "now" instead of replaying a backlog.
  await redisConnection.set(key(assetId), String(occurredAtMs), "EX", 30 * 24 * 60 * 60);
}
