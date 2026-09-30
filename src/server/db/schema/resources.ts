import {
  type AnyPgColumn,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { connections } from "./connections";
import { customers } from "./customers";

// Every real, ownable/billable thing across providers gets one row here. A
// resource is owned by exactly one customer (independent per resource, so a
// mailbox can belong to a different customer than the domain it lives under).
// Monitoring is an optional property (the `monitor` field), not the reason a
// row exists. Populated by connector discovery (upsert on provider+type+externalId).
export const resourceType = pgEnum("resource_type", [
  "registered_domain",
  "dns_zone",
  "ses_identity",
  "ses_tenant",
  "cloudfront_distribution",
  "acm_cert",
  "mailbox",
  "mail_domain",
  "container",
  "vps",
  "railway_project",
  "railway_service",
  // A physical/virtual host as a Configuration Item, identified by FQDN and
  // enriched by multiple connectors (hetzner, ssm, hetznerCloud) as sources.
  "host",
  // A domain as a Configuration Item, identified by name and enriched by AWS
  // (registry, dns, ses, cloudfront, acm) + mailcow facets.
  "domain",
]);

// Lifecycle of a Configuration Item. A resource no source has reported for a
// while is decommissioned, not deleted: its owner, cost history and audit
// trail stay readable, and it comes back as active if a source sees it again.
export const resourceStatus = pgEnum("resource_status", ["active", "decommissioned"]);

export const resourceProvider = pgEnum("resource_provider", [
  "aws",
  "hetzner",
  "railway",
  "mailcow",
  "other",
]);

export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    type: resourceType("type").notNull(),
    provider: resourceProvider("provider").notNull(),
    // Stable per provider: domain name, distribution id, cert ARN/CN, mailbox
    // address, host:container, project/service id. Together with provider+type
    // this is the upsert key.
    externalId: text("external_id").notNull(),
    // The one customer who owns/pays for it. set null so re-discovery and
    // customer edits never destroy a hand-set owner.
    ownerCustomerId: text("owner_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    // Hierarchy without forcing ownership inheritance (container->vps,
    // mailbox->mail_domain, distribution->zone). set null, NOT cascade.
    parentResourceId: text("parent_resource_id").references((): AnyPgColumn => resources.id, {
      onDelete: "set null",
    }),
    // Which connection discovered it. set null so deleting a connection never
    // wipes discovered resources or their owners.
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: resourceStatus("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    // Optional health probe config; only set for resources we monitor.
    monitor: jsonb("monitor").$type<Record<string, unknown>>(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Host CIs use a fixed provider='other' sentinel + type='host', so this
    // existing composite unique already guarantees FQDN uniqueness for hosts
    // (externalId = FQDN) without a partial index that would reference the new
    // 'host' enum value in DDL (the migrator runs all migrations in one tx, so
    // that would fail with "unsafe use of new enum value").
    unique("resources_provider_type_external_unq").on(t.provider, t.type, t.externalId),
    index("resources_owner_idx").on(t.ownerCustomerId),
    index("resources_type_idx").on(t.type),
    index("resources_parent_idx").on(t.parentResourceId),
    index("resources_status_idx").on(t.status),
  ],
);

// Audit trail of a Configuration Item: who changed which field from what to
// what. Written for owner and status changes from the UI, MCP and the worker.
export const resourceHistory = pgTable(
  "resource_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    // "user:<email>", "worker", "mcp:<token name>"
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resource_history_resource_idx").on(t.resourceId, t.createdAt)],
);
