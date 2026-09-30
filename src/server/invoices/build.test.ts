import { describe, expect, it } from "vitest";
import type { RevenueLine } from "../costs/billing";
import {
  buildInvoiceDraft,
  buildInvoiceLines,
  computeTotals,
  formatInvoiceNumber,
  isLastNumberOfYear,
  nextInvoiceNumber,
  parseInvoiceNumber,
} from "./build";

const line = (over: Partial<RevenueLine> = {}): RevenueLine => ({
  kind: "position",
  id: "p1",
  label: "Hosting",
  resourceId: null,
  quantity: 1,
  unitPriceCents: 1000,
  interval: "monthly",
  amountCents: 1000,
  ...over,
});

describe("buildInvoiceLines", () => {
  it("keeps quantity and unit price when they multiply out to the amount", () => {
    const lines = buildInvoiceLines([
      line({ quantity: 5, unitPriceCents: 200, amountCents: 1000, resourceId: "r1" }),
    ]);
    expect(lines).toEqual([
      {
        position: 1,
        label: "Hosting",
        quantity: 5,
        unitPriceCents: 200,
        amountCents: 1000,
        kind: "position",
        resourceId: "r1",
      },
    ]);
  });

  it("collapses a prorated yearly position to one line billed at its period share", () => {
    const [row] = buildInvoiceLines([
      line({ interval: "yearly", quantity: 1, unitPriceCents: 12000, amountCents: 1000 }),
    ]);
    expect(row?.label).toBe("Hosting (Monatsanteil)");
    expect(row?.quantity).toBe(1);
    expect(row?.unitPriceCents).toBe(1000);
    expect(row?.amountCents).toBe(1000);
  });

  it("numbers lines from one, keeps adjustments and drops zero amounts", () => {
    const lines = buildInvoiceLines([
      line({ label: "Hosting" }),
      line({ label: "Nichts", amountCents: 0 }),
      line({
        kind: "adjustment",
        id: null,
        label: "Gutschrift",
        unitPriceCents: -500,
        amountCents: -500,
      }),
    ]);
    expect(lines.map((l) => [l.position, l.label, l.kind])).toEqual([
      [1, "Hosting", "position"],
      [2, "Gutschrift", "adjustment"],
    ]);
  });
});

describe("computeTotals", () => {
  it("shows no VAT at a rate of zero", () => {
    expect(computeTotals([{ amountCents: 1000 }, { amountCents: 250 }], 0)).toEqual({
      subtotalCents: 1250,
      vatCents: 0,
      totalCents: 1250,
    });
  });

  it("computes VAT once on the net sum and rounds to whole cents", () => {
    // 19 % of 12,33 EUR is 2,3427 EUR, which rounds to 2,34 EUR.
    expect(computeTotals([{ amountCents: 1233 }], 19)).toEqual({
      subtotalCents: 1233,
      vatCents: 234,
      totalCents: 1467,
    });
    // Rounding on the sum, not per line: 3 x 3,33 EUR at 19 % is 1,8981 EUR.
    expect(
      computeTotals([{ amountCents: 333 }, { amountCents: 333 }, { amountCents: 333 }], 19),
    ).toEqual({ subtotalCents: 999, vatCents: 190, totalCents: 1189 });
  });

  it("rounds a negative net away from zero so a credit mirrors its charge", () => {
    expect(computeTotals([{ amountCents: -1233 }], 19).vatCents).toBe(-234);
    expect(computeTotals([{ amountCents: -50 }], 7).vatCents).toBe(-4);
    expect(computeTotals([{ amountCents: 50 }], 7).vatCents).toBe(4);
  });

  it("sums an empty invoice to zero", () => {
    expect(computeTotals([], 19)).toEqual({ subtotalCents: 0, vatCents: 0, totalCents: 0 });
  });
});

describe("buildInvoiceDraft", () => {
  it("returns lines and totals that add up", () => {
    const draft = buildInvoiceDraft(
      [
        line({ quantity: 2, unitPriceCents: 1500, amountCents: 3000 }),
        line({
          kind: "adjustment",
          id: null,
          label: "Einrichtung",
          unitPriceCents: 5000,
          amountCents: 5000,
        }),
      ],
      19,
    );
    expect(draft.lines).toHaveLength(2);
    expect(draft.subtotalCents).toBe(8000);
    expect(draft.vatCents).toBe(1520);
    expect(draft.totalCents).toBe(9520);
    expect(draft.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(draft.subtotalCents);
  });

  it("defaults to a rate of zero", () => {
    expect(buildInvoiceDraft([line()]).vatRatePercent).toBe(0);
    expect(buildInvoiceDraft([line()]).vatCents).toBe(0);
  });
});

describe("invoice numbering", () => {
  it("formats and parses the YYYY-NNNN scheme", () => {
    expect(formatInvoiceNumber(2026, 7)).toBe("2026-0007");
    expect(formatInvoiceNumber(2026, 12345)).toBe("2026-12345");
    expect(parseInvoiceNumber("2026-0007")).toEqual({ year: 2026, sequence: 7 });
    expect(parseInvoiceNumber("2026-7")).toBeNull();
    expect(parseInvoiceNumber("RE-2026-0007")).toBeNull();
  });

  it("starts at one and counts up gaplessly within a year", () => {
    expect(nextInvoiceNumber(2026, [])).toBe("2026-0001");
    expect(nextInvoiceNumber(2026, ["2026-0001", "2026-0002"])).toBe("2026-0003");
    // Order does not matter, the highest sequence wins.
    expect(nextInvoiceNumber(2026, ["2026-0003", "2026-0001"])).toBe("2026-0004");
  });

  it("restarts each calendar year and ignores other years", () => {
    expect(nextInvoiceNumber(2027, ["2026-0001", "2026-0002"])).toBe("2027-0001");
    expect(nextInvoiceNumber(2026, ["2025-0009", "2026-0004", "2027-0001"])).toBe("2026-0005");
  });

  it("only allows deleting the highest number of its year", () => {
    const numbers = ["2026-0001", "2026-0002", "2027-0001"];
    expect(isLastNumberOfYear("2026-0002", numbers)).toBe(true);
    expect(isLastNumberOfYear("2026-0001", numbers)).toBe(false);
    expect(isLastNumberOfYear("2027-0001", numbers)).toBe(true);
    expect(isLastNumberOfYear("kaputt", numbers)).toBe(false);
  });
});
