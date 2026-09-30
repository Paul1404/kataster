import { relations } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { customers } from "./customers";
import { resources } from "./resources";

// Lifecycle of an invoice. draft is still editable in the sense that it can be
// deleted; from issued on the document is a snapshot and only its status moves.
export const invoiceStatus = pgEnum("invoice_status", ["draft", "issued", "paid", "void"]);

// Where an invoice line comes from: a contract position, or a one-off adjustment
// (customer_pricing) of the billed period.
export const invoiceLineKind = pgEnum("invoice_line_kind", ["position", "adjustment"]);

/** Recipient block as it was at creation time. Never re-read from the customer. */
export interface InvoiceRecipient {
  name: string;
  customerNumber: string | null;
  address: string | null;
  billingEmail: string | null;
  vatId: string | null;
}

// One invoice for one customer and one billed period. The document is an
// immutable snapshot: lines, totals and the recipient block are frozen at
// creation and are never recomputed from the current contract positions.
export const invoices = pgTable(
  "invoices",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    // 'YYYY-NNNN', gapless and sequential within the calendar year of creation.
    number: text("number").notNull().unique(),
    period: text("period").notNull(), // 'YYYY-MM', the billed period
    status: invoiceStatus("status").notNull().default("draft"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    currency: text("currency").notNull().default("EUR"),
    // 0 means the small-business rule (Paragraph 19 UStG) applies.
    vatRatePercent: integer("vat_rate_percent").notNull().default(0),
    subtotalCents: integer("subtotal_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    recipient: jsonb("recipient").$type<InvoiceRecipient>().notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_period_idx").on(t.period),
  ],
);

// One billed line of an invoice, frozen with the document.
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    label: text("label").notNull(),
    quantity: doublePrecision("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    kind: invoiceLineKind("kind").notNull().default("position"),
    // Kept for traceability only; clearing it never changes the billed amount.
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, {
    fields: [invoices.customerId],
    references: [customers.id],
  }),
  lines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
}));
