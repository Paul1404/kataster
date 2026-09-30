import { sql } from "drizzle-orm";
import { db } from "../db";
import { checkResultHourly, checkResults } from "../db/schema/assets";

const DAY_MS = 86_400_000;

export function rawRetentionCutoff(now: Date, retentionDays: number): Date {
  const safeDays = Number.isFinite(retentionDays) ? Math.max(1, Math.floor(retentionDays)) : 1;
  const cutoff = new Date(now.getTime() - safeDays * DAY_MS);
  cutoff.setUTCMinutes(0, 0, 0);
  return cutoff;
}

export async function compactCheckResults(
  now: Date = new Date(),
  retentionDays: number = Number(process.env.CHECK_RESULTS_RETENTION_DAYS ?? 1),
): Promise<{ cutoff: Date; deleted: number }> {
  const cutoff = rawRetentionCutoff(now, retentionDays);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into ${checkResultHourly} (
        asset_id,
        bucket_start,
        total,
        down,
        degraded,
        latency_total_ms,
        latency_samples
      )
      select
        asset_id,
        date_trunc('hour', checked_at) as bucket_start,
        count(*)::int,
        count(*) filter (where status = 'down')::int,
        count(*) filter (where status = 'degraded')::int,
        coalesce(sum(latency_ms), 0)::int,
        count(latency_ms)::int
      from ${checkResults}
      where checked_at < ${cutoff}
      group by asset_id, date_trunc('hour', checked_at)
      on conflict (asset_id, bucket_start) do update set
        total = excluded.total,
        down = excluded.down,
        degraded = excluded.degraded,
        latency_total_ms = excluded.latency_total_ms,
        latency_samples = excluded.latency_samples
    `);

    const deletion = await tx.execute(sql`
      with deleted as (
        delete from ${checkResults}
        where checked_at < ${cutoff}
        returning 1
      )
      select count(*)::int as count from deleted
    `);
    const deleted = Number((deletion.rows[0] as { count?: number } | undefined)?.count ?? 0);
    return { cutoff, deleted };
  });
}
