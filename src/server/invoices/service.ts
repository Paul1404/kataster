// Invoicing service: the DB-backed end of the billing chain. It resolves what a
// customer owes for a period with the same pure engine the Abrechnung page uses,
// freezes that into an invoice document, and moves the document through its
// lifecycle. Once an invoice exists its lines, totals and recipient are never
// recomputed: the snapshot is the invoice.

import { and, asc, desc, eq, inArray, like, ne, sql } from "drizzle-orm";
import { BILLABLE_KINDS, resolveCharges } from "../costs/billing";
import { db } from "../db";
import { contractPositions, customerPricing } from "../db/schema/costs";
import { customers } from "../db/schema/customers";
import { type InvoiceRecipient, invoiceLines, invoices } from "../db/schema/invoices";
import { buildInvoiceDraft, isLastNumberOfYear, nextInvoiceNumber } from "./build";

export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

/** Days between the issue date and the due date printed on the document. */
export const PAYMENT_TERM_DAYS = 14;

export class InvoiceError extends Error {}

/** Own company details for the sender block. Not stored: they come from the env. */
export interface InvoiceSender {
  name: string | null;
  address: string | null;
  email: string | null;
  vatId: string | null;
  iban: string | null;
  /** False when nothing is configured, so the document can say so plainly. */
  configured: boolean;
}

const trimmed = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

/** Read the sender block from the environment. */
export function loadSender(): InvoiceSender {
  const sender = {
    name: trimmed(process.env.INVOICE_SENDER_NAME),
    address: trimmed(process.env.INVOICE_SENDER_ADDRESS),
    email: trimmed(process.env.INVOICE_SENDER_EMAIL),
    vatId: trimmed(process.env.INVOICE_SENDER_VAT_ID),
    iban: trimmed(process.env.INVOICE_SENDER_IBAN),
  };
  return { ...sender, configured: Boolean(sender.name || sender.address) };
}

/** Revenue lines per customer for a period, straight from the pure billing engine. */
async function loadPeriodCharges(period: string) {
  const [positionRows, adjustmentRows] = await Promise.all([
    db.select().from(contractPositions).orderBy(asc(contractPositions.label)),
    db
      .select({
        customerId: customerPricing.customerId,
        period: customerPricing.period,
        amountCents: customerPricing.amountCents,
        note: customerPricing.note,
      })
      .from(customerPricing)
      .where(eq(customerPricing.period, period)),
  ]);
  return resolveCharges(period, positionRows, adjustmentRows);
}

function recipientOf(customer: {
  name: string;
  customerNumber: string | null;
  billingAddress: string | null;
  address: string | null;
  billingEmail: string | null;
  vatId: string | null;
}): InvoiceRecipient {
  return {
    name: customer.name,
    customerNumber: customer.customerNumber,
    address: customer.billingAddress ?? customer.address,
    billingEmail: customer.billingEmail,
    vatId: customer.vatId,
  };
}

export interface CreateInvoiceInput {
  customerId: string;
  period: string;
  vatRatePercent?: number;
  note?: string | null;
}

export interface InvoiceRow {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  period: string;
  status: InvoiceStatus;
  issuedAt: Date | null;
  dueAt: Date | null;
  currency: string;
  vatRatePercent: number;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  note: string | null;
  createdAt: Date;
}

/**
 * Create one invoice for one customer and period. The number is allocated inside
 * the insert transaction under a per-year advisory lock, so two concurrent
 * creations queue instead of picking the same number. Fails when the customer
 * owes nothing in the period: an empty invoice is not a document worth a number.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceRow> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!customer) throw new InvoiceError("Kunde nicht gefunden");
  if (!BILLABLE_KINDS.has(customer.kind)) {
    throw new InvoiceError("Für diesen Kundentyp werden keine Rechnungen gestellt");
  }

  const charges = await loadPeriodCharges(input.period);
  const draft = buildInvoiceDraft(
    charges.get(input.customerId)?.lines ?? [],
    input.vatRatePercent ?? 0,
  );
  if (draft.lines.length === 0) {
    throw new InvoiceError("Für diesen Kunden gibt es in diesem Zeitraum nichts abzurechnen");
  }

  const year = new Date().getFullYear();
  const created = await db.transaction(async (tx) => {
    // Blocking, transaction-scoped: the number must be gapless, so a second
    // creation waits for this one to commit rather than reading a stale maximum.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invoice-number:${year}`}))`);
    const taken = await tx
      .select({ number: invoices.number })
      .from(invoices)
      .where(like(invoices.number, `${year}-%`));
    const number = nextInvoiceNumber(
      year,
      taken.map((r) => r.number),
    );

    const [row] = await tx
      .insert(invoices)
      .values({
        customerId: customer.id,
        number,
        period: input.period,
        status: "draft",
        vatRatePercent: draft.vatRatePercent,
        subtotalCents: draft.subtotalCents,
        vatCents: draft.vatCents,
        totalCents: draft.totalCents,
        recipient: recipientOf(customer),
        note: input.note ?? null,
      })
      .returning();
    if (!row) throw new InvoiceError("Rechnung konnte nicht angelegt werden");

    await tx.insert(invoiceLines).values(
      draft.lines.map((l) => ({
        invoiceId: row.id,
        position: l.position,
        label: l.label,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        amountCents: l.amountCents,
        kind: l.kind,
        resourceId: l.resourceId,
      })),
    );
    return row;
  });

  return { ...created, customerName: customer.name, status: created.status as InvoiceStatus };
}

/**
 * Create an invoice for every billable customer that owes something in the period
 * and has no invoice for it yet. Voided invoices do not count, so a corrected run
 * after a void picks the customer up again. Sequential on purpose: the numbers
 * then follow the order the customers are billed in.
 */
export async function createInvoicesForPeriod(input: {
  period: string;
  vatRatePercent?: number;
}): Promise<{ created: InvoiceRow[]; skipped: number }> {
  const [charges, customerRows, existing] = await Promise.all([
    loadPeriodCharges(input.period),
    db.select({ id: customers.id, kind: customers.kind }).from(customers),
    db
      .select({ customerId: invoices.customerId })
      .from(invoices)
      .where(and(eq(invoices.period, input.period), ne(invoices.status, "void"))),
  ]);
  const invoiced = new Set(existing.map((r) => r.customerId));
  const billable = customerRows.filter((c) => BILLABLE_KINDS.has(c.kind));

  const created: InvoiceRow[] = [];
  let skipped = 0;
  for (const customer of billable) {
    const lines = charges.get(customer.id)?.lines ?? [];
    if (lines.length === 0 || lines.every((l) => l.amountCents === 0)) continue;
    if (invoiced.has(customer.id)) {
      skipped += 1;
      continue;
    }
    created.push(
      await createInvoice({
        customerId: customer.id,
        period: input.period,
        vatRatePercent: input.vatRatePercent,
      }),
    );
  }
  return { created, skipped };
}

/** Invoices, newest number first, optionally narrowed to a period, status or customer. */
export async function listInvoices(filter?: {
  period?: string;
  status?: InvoiceStatus;
  customerId?: string;
}): Promise<InvoiceRow[]> {
  const conditions = [
    filter?.period ? eq(invoices.period, filter.period) : undefined,
    filter?.status ? eq(invoices.status, filter.status) : undefined,
    filter?.customerId ? eq(invoices.customerId, filter.customerId) : undefined,
  ].filter((c) => c != null);

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      customerId: invoices.customerId,
      customerName: customers.name,
      period: invoices.period,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
      currency: invoices.currency,
      vatRatePercent: invoices.vatRatePercent,
      subtotalCents: invoices.subtotalCents,
      vatCents: invoices.vatCents,
      totalCents: invoices.totalCents,
      note: invoices.note,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(invoices.number));
  return rows;
}

export interface InvoiceDocument {
  invoice: InvoiceRow & { recipient: InvoiceRecipient };
  lines: {
    id: string;
    position: number;
    label: string;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    kind: "position" | "adjustment";
    resourceId: string | null;
  }[];
  sender: InvoiceSender;
  paymentTermDays: number;
}

/** One invoice with its frozen lines, the recipient snapshot and the sender block. */
export async function getInvoice(id: string): Promise<InvoiceDocument> {
  const [row] = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      customerId: invoices.customerId,
      customerName: customers.name,
      period: invoices.period,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
      currency: invoices.currency,
      vatRatePercent: invoices.vatRatePercent,
      subtotalCents: invoices.subtotalCents,
      vatCents: invoices.vatCents,
      totalCents: invoices.totalCents,
      note: invoices.note,
      createdAt: invoices.createdAt,
      recipient: invoices.recipient,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, id))
    .limit(1);
  if (!row) throw new InvoiceError("Rechnung nicht gefunden");

  const lines = await db
    .select({
      id: invoiceLines.id,
      position: invoiceLines.position,
      label: invoiceLines.label,
      quantity: invoiceLines.quantity,
      unitPriceCents: invoiceLines.unitPriceCents,
      amountCents: invoiceLines.amountCents,
      kind: invoiceLines.kind,
      resourceId: invoiceLines.resourceId,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(asc(invoiceLines.position));

  return { invoice: row, lines, sender: loadSender(), paymentTermDays: PAYMENT_TERM_DAYS };
}

async function setStatus(
  id: string,
  from: InvoiceStatus[],
  patch: { status: InvoiceStatus; issuedAt?: Date; dueAt?: Date },
  message: string,
): Promise<{ id: string; status: InvoiceStatus }> {
  const [row] = await db
    .update(invoices)
    .set(patch)
    .where(and(eq(invoices.id, id), inArray(invoices.status, from)))
    .returning({ id: invoices.id, status: invoices.status });
  if (!row) throw new InvoiceError(message);
  return { id: row.id, status: row.status as InvoiceStatus };
}

/** Freeze a draft: it gets its issue and due date and becomes a sent document. */
export function issueInvoice(id: string) {
  const issuedAt = new Date();
  const dueAt = new Date(issuedAt.getTime() + PAYMENT_TERM_DAYS * 24 * 60 * 60 * 1000);
  return setStatus(
    id,
    ["draft"],
    { status: "issued", issuedAt, dueAt },
    "Nur Entwürfe lassen sich festschreiben",
  );
}

export function markInvoicePaid(id: string) {
  return setStatus(
    id,
    ["issued"],
    { status: "paid" },
    "Nur festgeschriebene Rechnungen lassen sich als bezahlt markieren",
  );
}

/** Cancel an invoice. The document and its number stay, only the status changes. */
export function voidInvoice(id: string) {
  return setStatus(
    id,
    ["draft", "issued"],
    { status: "void" },
    "Diese Rechnung lässt sich nicht mehr stornieren",
  );
}

/**
 * Delete a draft. Only the highest number of its year may go, otherwise the
 * sequence would keep a hole; anything below that is voided instead.
 */
export async function deleteDraftInvoice(id: string): Promise<{ ok: true }> {
  const [row] = await db
    .select({ number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  if (!row) throw new InvoiceError("Rechnung nicht gefunden");
  if (row.status !== "draft") throw new InvoiceError("Nur Entwürfe lassen sich löschen");

  const year = row.number.slice(0, 4);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invoice-number:${year}`}))`);
    const taken = await tx
      .select({ number: invoices.number })
      .from(invoices)
      .where(like(invoices.number, `${year}-%`));
    if (
      !isLastNumberOfYear(
        row.number,
        taken.map((r) => r.number),
      )
    ) {
      throw new InvoiceError(
        "Nur die zuletzt vergebene Rechnungsnummer des Jahres lässt sich löschen. Ältere Entwürfe bitte stornieren.",
      );
    }
    await tx.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.status, "draft")));
  });
  return { ok: true };
}

/** Customer ids that already have a non-void invoice for a period, for the Abrechnung page. */
export async function invoicedCustomerIds(period: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: invoices.customerId })
    .from(invoices)
    .where(and(eq(invoices.period, period), ne(invoices.status, "void")));
  return [...new Set(rows.map((r) => r.customerId))];
}
