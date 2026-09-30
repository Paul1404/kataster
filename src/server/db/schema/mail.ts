import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { customers } from "./customers";

// Mailcow domains discovered from a mailcow asset's checks. Each can be assigned
// to a customer (location). Stats are refreshed every check; customerId is kept.
export const mailDomains = pgTable(
  "mail_domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    mailboxCount: integer("mailbox_count").notNull().default(0),
    aliasCount: integer("alias_count").notNull().default(0),
    storageBytes: doublePrecision("storage_bytes").notNull().default(0),
    messages: doublePrecision("messages").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mail_domains_asset_name_unq").on(t.assetId, t.name),
    index("mail_domains_customer_idx").on(t.customerId),
  ],
);

// Individual mailboxes discovered from a mailcow asset. Assignable to a customer.
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    domainName: text("domain_name").notNull(),
    address: text("address").notNull(),
    name: text("name"),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    quotaBytes: doublePrecision("quota_bytes").notNull().default(0),
    quotaUsedBytes: doublePrecision("quota_used_bytes").notNull().default(0),
    messages: doublePrecision("messages").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mailboxes_asset_address_unq").on(t.assetId, t.address),
    index("mailboxes_customer_idx").on(t.customerId),
    index("mailboxes_asset_domain_idx").on(t.assetId, t.domainName),
  ],
);

export const mailDomainsRelations = relations(mailDomains, ({ one }) => ({
  asset: one(assets, { fields: [mailDomains.assetId], references: [assets.id] }),
  location: one(customers, { fields: [mailDomains.customerId], references: [customers.id] }),
}));

export const mailboxesRelations = relations(mailboxes, ({ one }) => ({
  asset: one(assets, { fields: [mailboxes.assetId], references: [assets.id] }),
  location: one(customers, { fields: [mailboxes.customerId], references: [customers.id] }),
}));
