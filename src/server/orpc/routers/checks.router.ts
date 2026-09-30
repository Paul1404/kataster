import { and, desc, eq, gte, sql } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { checkResultHourly, checkResults } from "../../db/schema/assets";
import { authed } from "../base";

export const checksRouter = {
  // Uptime over a window: the share of checks that were not "down". Degraded
  // counts as up-but-slow, not downtime.
  uptime: authed
    .input(
      v.object({
        assetId: v.string(),
        windowHours: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(8760)), 24),
      }),
    )
    .handler(async ({ input }) => {
      const since = new Date(Date.now() - input.windowHours * 3_600_000);
      const bucketSince = new Date(since);
      bucketSince.setUTCMinutes(0, 0, 0);
      const [rawRows, hourlyRows] = await Promise.all([
        db
          .select({
            total: sql<number>`count(*)::int`,
            down: sql<number>`count(*) filter (where ${checkResults.status} = 'down')::int`,
            degraded: sql<number>`count(*) filter (where ${checkResults.status} = 'degraded')::int`,
          })
          .from(checkResults)
          .where(and(eq(checkResults.assetId, input.assetId), gte(checkResults.checkedAt, since))),
        db
          .select({
            total: sql<number>`coalesce(sum(${checkResultHourly.total}), 0)::int`,
            down: sql<number>`coalesce(sum(${checkResultHourly.down}), 0)::int`,
            degraded: sql<number>`coalesce(sum(${checkResultHourly.degraded}), 0)::int`,
          })
          .from(checkResultHourly)
          .where(
            and(
              eq(checkResultHourly.assetId, input.assetId),
              gte(checkResultHourly.bucketStart, bucketSince),
            ),
          ),
      ]);
      const raw = rawRows[0];
      const hourly = hourlyRows[0];
      const total = (raw?.total ?? 0) + (hourly?.total ?? 0);
      const down = (raw?.down ?? 0) + (hourly?.down ?? 0);
      return {
        windowHours: input.windowHours,
        total,
        down,
        degraded: (raw?.degraded ?? 0) + (hourly?.degraded ?? 0),
        uptimePercent: total > 0 ? ((total - down) / total) * 100 : null,
        includesHourlyRollups: (hourly?.total ?? 0) > 0,
      };
    }),

  history: authed
    .input(
      v.object({
        assetId: v.string(),
        limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(500)), 100),
      }),
    )
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(checkResults)
        .where(eq(checkResults.assetId, input.assetId))
        .orderBy(desc(checkResults.checkedAt))
        .limit(input.limit);
      // Return chronological (oldest first) for charting.
      return rows.reverse();
    }),
};
