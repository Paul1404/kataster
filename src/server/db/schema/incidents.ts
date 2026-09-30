import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { assets, checkStatus } from "./assets";

// An unhealthy stretch for an asset. Opened on a healthy->unhealthy transition
// and closed on recovery, written from persistCheckResult (the one chokepoint
// for worker + ingest results). At most one open incident per asset.
export const incidents = pgTable(
  "incidents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    // Worst status seen during the incident (degraded can escalate to down).
    status: checkStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incidents_asset_started_idx").on(t.assetId, t.startedAt),
    // Enforce a single open incident per asset (endedAt is null).
    uniqueIndex("incidents_one_open_per_asset").on(t.assetId).where(sql`${t.endedAt} is null`),
  ],
);

export const incidentsRelations = relations(incidents, ({ one }) => ({
  asset: one(assets, { fields: [incidents.assetId], references: [assets.id] }),
}));
