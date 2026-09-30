import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { connections } from "./connections";
import { customers } from "./customers";
import { resources } from "./resources";

export const checkStatus = pgEnum("check_status", ["up", "down", "degraded", "unknown"]);

export const assetGroups = pgTable("asset_groups", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The things being monitored. `connectorId` is a registry key, deliberately NOT a
// foreign key since the registry is code.
export const assets = pgTable(
  "assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    connectorId: text("connector_id").notNull(),
    target: text("target").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    connectionId: text("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    groupId: text("group_id").references(() => assetGroups.id, { onDelete: "set null" }),
    // Map placement: an asset appears on the map via its location's coordinates.
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    // The Configuration Item this asset monitors (a host CI). An asset is a
    // monitoring schedule pointed at a CI; monitoring history stays keyed to the
    // asset, so this is just a link the CI page reads for live status.
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    // While set and in the future, the asset is in maintenance: checks still run
    // and history is kept, but no incidents (or future alerts) are opened.
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    // Denormalized current state for fast list rendering (updated by worker/ingest).
    lastStatus: checkStatus("last_status").notNull().default("unknown"),
    lastLatencyMs: integer("last_latency_ms"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("assets_enabled_idx").on(t.enabled),
    index("assets_connector_idx").on(t.connectorId),
    index("assets_customer_idx").on(t.customerId),
    index("assets_resource_idx").on(t.resourceId),
  ],
);

export const checkResults = pgTable(
  "check_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    status: checkStatus("status").notNull(),
    latencyMs: integer("latency_ms"),
    message: text("message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("check_results_asset_time_idx").on(t.assetId, t.checkedAt),
    // Retention scans by time across every asset. Without this index Postgres
    // reads the full raw-history table into page cache during each compaction.
    index("check_results_checked_at_idx").on(t.checkedAt),
  ],
);

// Hourly rollups preserve long-range uptime and latency trends after raw probe
// rows age out. A bucket is written once by the retention job, transactionally
// with deleting the corresponding raw rows.
export const checkResultHourly = pgTable(
  "check_result_hourly",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    total: integer("total").notNull(),
    down: integer("down").notNull(),
    degraded: integer("degraded").notNull(),
    latencyTotalMs: integer("latency_total_ms").notNull(),
    latencySamples: integer("latency_samples").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.bucketStart] }),
    index("check_result_hourly_time_idx").on(t.bucketStart),
  ],
);

export const assetsRelations = relations(assets, ({ one, many }) => ({
  group: one(assetGroups, { fields: [assets.groupId], references: [assetGroups.id] }),
  connection: one(connections, {
    fields: [assets.connectionId],
    references: [connections.id],
  }),
  location: one(customers, { fields: [assets.customerId], references: [customers.id] }),
  results: many(checkResults),
}));

export const assetGroupsRelations = relations(assetGroups, ({ many }) => ({
  assets: many(assets),
}));

export const checkResultsRelations = relations(checkResults, ({ one }) => ({
  asset: one(assets, { fields: [checkResults.assetId], references: [assets.id] }),
}));

export const checkResultHourlyRelations = relations(checkResultHourly, ({ one }) => ({
  asset: one(assets, { fields: [checkResultHourly.assetId], references: [assets.id] }),
}));
