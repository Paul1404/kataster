import {
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { customers } from "./customers";

// Direction of a single mail event. Outbound = a local mailbox sent it; inbound =
// it arrived for a local mailbox. Drives which way the map particle travels.
export const mailDirection = pgEnum("mail_direction", ["inbound", "outbound"]);

// Per-message mail-flow events derived from a mailcow asset's rspamd history.
// Each row is one (message, recipient-edge, direction) and feeds the live map
// animation, the activity feed, and the scrub-back timeline replay. Endpoints are
// resolved at ingest so reads are flat indexed scans with no joins.
export const mailEvents = pgTable(
  "mail_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    // Recipient ordinal so a multi-recipient message fans out without colliding.
    rcptIndex: integer("rcpt_index").notNull().default(0),
    direction: mailDirection("direction").notNull(),
    // The edge this mail flowed on. Nullable: a domain may not be placed on the
    // map yet (kept for the feed/counts, but produces no particle).
    serverCustomerId: text("server_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    endpointCustomerId: text("endpoint_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    domainName: text("domain_name").notNull(),
    sender: text("sender"),
    recipient: text("recipient"),
    action: text("action"),
    score: doublePrecision("score"),
    sizeBytes: doublePrecision("size_bytes"),
    // Real event time from rspamd (unix_time). ingestedAt is our clock fallback.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mail_events_msg_unq").on(t.assetId, t.messageId, t.rcptIndex, t.direction),
    index("mail_events_occurred_idx").on(t.occurredAt),
    index("mail_events_asset_occurred_idx").on(t.assetId, t.occurredAt),
    // The live tail filters and orders by ingestedAt.
    index("mail_events_ingested_idx").on(t.ingestedAt),
  ],
);
