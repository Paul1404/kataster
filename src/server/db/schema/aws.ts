import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { customers } from "./customers";

// A domain discovered from an AWS account asset. The natural hub for the
// per-customer single pane: one row folds together a domain's DNS (Route 53
// hosted zone), registry (Route 53 Domains) and email (SESv2 identity) facts.
// Stats refresh every check; customerId (the customer it belongs to) is kept.
export const domains = pgTable(
  "domains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),

    // Route 53 hosted zone (DNS)
    hostedZoneId: text("hosted_zone_id"),
    isPrivateZone: boolean("is_private_zone").notNull().default(false),
    recordCount: integer("record_count"),
    dnssecEnabled: boolean("dnssec_enabled"),

    // Route 53 Domains (registry)
    registered: boolean("registered").notNull().default(false),
    registrar: text("registrar"),
    registryExpiresAt: timestamp("registry_expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew"),
    transferLock: boolean("transfer_lock"),
    // Operator flag: the domain is intentionally being let go, so suppress its
    // expiry / auto-renew warnings. Preserved across discovery (not in the upsert).
    decommissioned: boolean("decommissioned").notNull().default(false),

    // SESv2 identity (region-scoped, so we record where it was found)
    sesVerified: boolean("ses_verified").notNull().default(false),
    sesSendingEnabled: boolean("ses_sending_enabled"),
    sesRegion: text("ses_region"),

    findingCount: integer("finding_count").notNull().default(0),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("domains_asset_name_unq").on(t.assetId, t.name),
    index("domains_customer_idx").on(t.customerId),
    index("domains_name_idx").on(t.name),
  ],
);

// A CloudFront distribution discovered from an AWS account asset. Kept separate
// from `domains` because one distribution can carry several aliases. Mapped to a
// customer via its primary alias matching a domain name.
export const webDistributions = pgTable(
  "web_distributions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    distributionId: text("distribution_id").notNull(),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    primaryAlias: text("primary_alias"),
    originDomain: text("origin_domain"),
    // "serve" (origin content) or "redirect" (inferred 301/302). Best-effort.
    behavior: text("behavior").notNull().default("serve"),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("web_distributions_asset_dist_unq").on(t.assetId, t.distributionId),
    index("web_distributions_customer_idx").on(t.customerId),
    index("web_distributions_primary_alias_idx").on(t.primaryAlias),
  ],
);

export const domainsRelations = relations(domains, ({ one }) => ({
  asset: one(assets, { fields: [domains.assetId], references: [assets.id] }),
  location: one(customers, { fields: [domains.customerId], references: [customers.id] }),
}));

export const webDistributionsRelations = relations(webDistributions, ({ one }) => ({
  asset: one(assets, { fields: [webDistributions.assetId], references: [assets.id] }),
  location: one(customers, {
    fields: [webDistributions.customerId],
    references: [customers.id],
  }),
}));
