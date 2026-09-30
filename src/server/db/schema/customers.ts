import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { assets } from "./assets";

// Direction/semantics of a connection between two customers on the map.
export const relationType = pgEnum("relation_type", [
  "depends_on",
  "feeds",
  "connects",
  "monitors",
]);

// What a customer record represents. Drives map styling and CRM grouping.
export const customerKind = pgEnum("customer_kind", [
  "provider",
  "customer_private",
  "customer_business",
  "internal",
  "partner",
]);

// CRM lifecycle of a customer.
export const customerStatus = pgEnum("customer_status", ["active", "prospect", "churned"]);

// A CRM record: a customer, provider, or internal entity. Resources are owned by one.
// Latitude/longitude are optional; when present the record is placed on the map.
export const customers = pgTable(
  "customers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    kind: customerKind("kind").notNull().default("customer_business"),
    status: customerStatus("status").notNull().default("active"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    address: text("address"),
    // CRM / invoicing fields. customerNumber is what appears on invoices.
    customerNumber: text("customer_number"),
    billingEmail: text("billing_email"),
    billingAddress: text("billing_address"),
    vatId: text("vat_id"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("customers_kind_idx").on(t.kind)],
);

// People attached to a customer (CRM). Many per customer.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("customer_contacts_customer_idx").on(t.customerId)],
);

// User-defined edges between customers, powering the data-flow lines on the map.
export const customerRelations = pgTable(
  "customer_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fromCustomerId: text("from_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    toCustomerId: text("to_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    type: relationType("type").notNull().default("connects"),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_relations_from_idx").on(t.fromCustomerId),
    index("customer_relations_to_idx").on(t.toCustomerId),
    unique("customer_relations_pair_unq").on(t.fromCustomerId, t.toCustomerId, t.type),
  ],
);

export const customersRelations = relations(customers, ({ many }) => ({
  assets: many(assets),
  contacts: many(customerContacts),
}));

export const customerContactsRelations = relations(customerContacts, ({ one }) => ({
  customer: one(customers, {
    fields: [customerContacts.customerId],
    references: [customers.id],
  }),
}));

export const customerRelationsRelations = relations(customerRelations, ({ one }) => ({
  from: one(customers, {
    fields: [customerRelations.fromCustomerId],
    references: [customers.id],
    relationName: "from",
  }),
  to: one(customers, {
    fields: [customerRelations.toCustomerId],
    references: [customers.id],
    relationName: "to",
  }),
}));
