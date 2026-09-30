import { relations } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { customers } from "./customers";

// Where a certificate was observed: a live TLS handshake (http connector) or
// AWS Certificate Manager (aws connector).
export const certSource = pgEnum("cert_source", ["tls", "acm"]);

// Certificates discovered per asset. Refreshed every check; customerId is kept
// and auto-mapped to a customer by common name. Feeds the "expiring soon" view.
export const certificates = pgTable(
  "certificates",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
    source: certSource("source").notNull(),
    commonName: text("common_name").notNull(),
    sans: jsonb("sans").$type<string[]>().notNull().default([]),
    issuer: text("issuer"),
    notAfter: timestamp("not_after", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("certificates_asset_source_cn_unq").on(t.assetId, t.source, t.commonName),
    index("certificates_customer_idx").on(t.customerId),
    index("certificates_not_after_idx").on(t.notAfter),
  ],
);

export const certificatesRelations = relations(certificates, ({ one }) => ({
  asset: one(assets, { fields: [certificates.assetId], references: [assets.id] }),
  location: one(customers, { fields: [certificates.customerId], references: [customers.id] }),
}));
