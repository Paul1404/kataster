import { ORPCError } from "@orpc/server";
import * as v from "valibot";
import {
  createInvoice,
  createInvoicesForPeriod,
  deleteDraftInvoice,
  getInvoice,
  InvoiceError,
  invoicedCustomerIds,
  issueInvoice,
  listInvoices,
  markInvoicePaid,
  voidInvoice,
} from "../../invoices/service";
import { authed } from "../base";

const Period = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}$/, "Zeitraum muss YYYY-MM sein"));
const Status = v.picklist(["draft", "issued", "paid", "void"]);
const VatRate = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100));
const Id = v.object({ id: v.string() });

/** Turn a service error into a German oRPC error the UI can show in a toast. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InvoiceError) {
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    throw error;
  }
}

// Invoicing: the document end of the billing chain. An invoice is a snapshot of
// what a customer owed for a period; its lines are never recomputed afterwards.
export const invoicesRouter = {
  list: authed
    .input(
      v.optional(
        v.object({
          period: v.optional(Period),
          status: v.optional(Status),
          customerId: v.optional(v.string()),
        }),
      ),
    )
    .handler(({ input }) => listInvoices(input)),

  get: authed.input(Id).handler(({ input }) => run(() => getInvoice(input.id))),

  /** Customers that already have a non-void invoice for a period. */
  invoicedCustomers: authed
    .input(v.object({ period: Period }))
    .handler(({ input }) => invoicedCustomerIds(input.period)),

  create: authed
    .input(
      v.object({
        customerId: v.string(),
        period: Period,
        vatRatePercent: v.optional(VatRate),
        note: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(500)))),
      }),
    )
    .handler(({ input }) => run(() => createInvoice(input))),

  createForPeriod: authed
    .input(v.object({ period: Period, vatRatePercent: v.optional(VatRate) }))
    .handler(({ input }) => run(() => createInvoicesForPeriod(input))),

  issue: authed.input(Id).handler(({ input }) => run(() => issueInvoice(input.id))),

  markPaid: authed.input(Id).handler(({ input }) => run(() => markInvoicePaid(input.id))),

  void: authed.input(Id).handler(({ input }) => run(() => voidInvoice(input.id))),

  remove: authed.input(Id).handler(({ input }) => run(() => deleteDraftInvoice(input.id))),
};
