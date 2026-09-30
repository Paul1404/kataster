// Pure invoicing engine. Turns the revenue lines the billing engine resolves for
// a period into the lines of an invoice document, and computes net, VAT and gross
// in integer cents. No DB access, no dates from the environment: everything the
// caller needs to freeze into a snapshot is derived here.

import type { RevenueLine } from "../costs/billing";

export type InvoiceLineKind = "position" | "adjustment";

export interface InvoiceLineDraft {
  /** Sort order on the document, starting at 1. */
  position: number;
  label: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  kind: InvoiceLineKind;
  resourceId: string | null;
}

export interface InvoiceTotals {
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
}

export interface InvoiceDraft extends InvoiceTotals {
  lines: InvoiceLineDraft[];
  vatRatePercent: number;
}

/** Label appended when a line's period share is not quantity times unit price. */
export const PRORATED_LABEL_SUFFIX = "Monatsanteil";

/** Round half away from zero, so a credit rounds like the charge it reverses. */
function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Turn a period's revenue lines into invoice lines. A line whose period amount is
 * quantity times unit price keeps both, so the document shows the real unit
 * price. A yearly position bills one twelfth per period, which no quantity times
 * unit price reproduces exactly, so it collapses to a single prorated line whose
 * unit price is the amount actually billed. Zero-amount lines are dropped: they
 * are noise on a document a customer has to read.
 */
export function buildInvoiceLines(revenueLines: RevenueLine[]): InvoiceLineDraft[] {
  const out: InvoiceLineDraft[] = [];
  for (const line of revenueLines) {
    if (line.amountCents === 0) continue;
    const exact =
      line.quantity > 0 && roundCents(line.quantity * line.unitPriceCents) === line.amountCents;
    out.push({
      position: out.length + 1,
      label: exact ? line.label : `${line.label} (${PRORATED_LABEL_SUFFIX})`,
      quantity: exact ? line.quantity : 1,
      unitPriceCents: exact ? line.unitPriceCents : line.amountCents,
      amountCents: line.amountCents,
      kind: line.kind,
      resourceId: line.resourceId,
    });
  }
  return out;
}

/**
 * Net, VAT and gross for a set of lines. VAT is computed once on the net sum, not
 * per line, so the document always adds up. A rate of 0 means the small-business
 * rule (Paragraph 19 UStG) applies and no VAT is shown.
 */
export function computeTotals(
  lines: Pick<InvoiceLineDraft, "amountCents">[],
  vatRatePercent = 0,
): InvoiceTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const vatCents = vatRatePercent === 0 ? 0 : roundCents((subtotalCents * vatRatePercent) / 100);
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

/** Lines plus totals for one customer and period, ready to be persisted. */
export function buildInvoiceDraft(revenueLines: RevenueLine[], vatRatePercent = 0): InvoiceDraft {
  const lines = buildInvoiceLines(revenueLines);
  return { lines, vatRatePercent, ...computeTotals(lines, vatRatePercent) };
}

// --- Numbering ---------------------------------------------------------------

const NUMBER_PATTERN = /^(\d{4})-(\d{4,})$/;

/** 2026, 7 -> "2026-0007". */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `${year}-${String(sequence).padStart(4, "0")}`;
}

/** "2026-0007" -> { year: 2026, sequence: 7 }; null for anything else. */
export function parseInvoiceNumber(value: string): { year: number; sequence: number } | null {
  const match = NUMBER_PATTERN.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), sequence: Number(match[2]) };
}

/**
 * The next number for a calendar year: one above the highest sequence already
 * used in that year, starting at 1. Numbers of other years are ignored, so every
 * year restarts at 0001. Callers must allocate under a lock, otherwise two
 * concurrent creations pick the same number.
 */
export function nextInvoiceNumber(year: number, existingNumbers: string[]): string {
  let highest = 0;
  for (const value of existingNumbers) {
    const parsed = parseInvoiceNumber(value);
    if (parsed && parsed.year === year && parsed.sequence > highest) highest = parsed.sequence;
  }
  return formatInvoiceNumber(year, highest + 1);
}

/**
 * True when deleting this number leaves the year's sequence gapless, i.e. it is
 * the highest number issued in its year. Drafts below it must be voided instead.
 */
export function isLastNumberOfYear(value: string, existingNumbers: string[]): boolean {
  const parsed = parseInvoiceNumber(value);
  if (!parsed) return false;
  return (
    nextInvoiceNumber(parsed.year, existingNumbers) ===
    formatInvoiceNumber(parsed.year, parsed.sequence + 1)
  );
}
