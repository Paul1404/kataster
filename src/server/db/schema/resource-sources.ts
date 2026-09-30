import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { resources } from "./resources";

// Per-source facets for a Configuration Item. Each connector that discovers a
// resource (a host, especially) writes its own row here instead of clobbering a
// shared metadata blob, so several sources can enrich one CI. `ips` is broken out
// of `data` so hosts can be reconciled across sources by a shared IP.
export const resourceSources = pgTable(
  "resource_sources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'ssm' | 'hetznerCloud' | 'mailcow'
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    ips: jsonb("ips").$type<string[]>().notNull().default([]),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("resource_sources_resource_source_unq").on(t.resourceId, t.source),
    index("resource_sources_resource_idx").on(t.resourceId),
  ],
);
