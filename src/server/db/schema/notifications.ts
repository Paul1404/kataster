import { relations } from "drizzle-orm";
import { boolean, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Outbound alerting. Kataster knows about incidents, expiries, a dead worker and
// an incomplete billing month; these tables decide who gets told and record what
// was actually sent.

export const notificationChannelKind = pgEnum("notification_channel_kind", ["webhook"]);

export const notificationRuleKind = pgEnum("notification_rule_kind", [
  "incident_opened",
  "incident_resolved",
  "expiry_soon",
  "worker_down",
  "billing_incomplete",
]);

export const notificationDeliveryStatus = pgEnum("notification_delivery_status", [
  "sent",
  "failed",
]);

/**
 * A delivery target. `target` holds the AES-256-GCM encrypted webhook URL (the
 * same envelope as connector credentials). The plaintext never leaves the
 * server; the UI only ever sees `targetPreview` (host plus last four chars).
 */
export const notificationChannels = pgTable("notification_channels", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  kind: notificationChannelKind("kind").notNull().default("webhook"),
  target: text("target").notNull(),
  targetPreview: text("target_preview").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** What a channel wants to hear about. `thresholdDays` is only used by expiry_soon. */
export const notificationRules = pgTable(
  "notification_rules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    kind: notificationRuleKind("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    thresholdDays: integer("threshold_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("notification_rules_channel_idx").on(t.channelId)],
);

/**
 * One row per event that was attempted. `dedupeKey` is unique across the whole
 * table, which is what makes "the same event never fires twice" a database
 * guarantee rather than a code convention: the sender inserts the row first and
 * only sends when the insert actually created it.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    ruleKind: notificationRuleKind("rule_kind").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: notificationDeliveryStatus("status").notNull().default("sent"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_deliveries_created_idx").on(t.createdAt)],
);

export const notificationChannelsRelations = relations(notificationChannels, ({ many }) => ({
  rules: many(notificationRules),
  deliveries: many(notificationDeliveries),
}));

export const notificationRulesRelations = relations(notificationRules, ({ one }) => ({
  channel: one(notificationChannels, {
    fields: [notificationRules.channelId],
    references: [notificationChannels.id],
  }),
}));

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  channel: one(notificationChannels, {
    fields: [notificationDeliveries.channelId],
    references: [notificationChannels.id],
  }),
}));
