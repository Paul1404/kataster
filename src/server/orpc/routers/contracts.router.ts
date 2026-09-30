import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { contractPositions } from "../../db/schema/costs";
import { customers } from "../../db/schema/customers";
import { resources } from "../../db/schema/resources";
import { authed } from "../base";

const Period = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}$/, "Zeitraum muss YYYY-MM sein"));

const PositionInput = v.object({
  id: v.optional(v.string()),
  customerId: v.string(),
  resourceId: v.optional(v.nullable(v.string())),
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  quantity: v.optional(v.pipe(v.number(), v.minValue(0))),
  unitPriceCents: v.pipe(v.number(), v.integer()),
  interval: v.optional(v.picklist(["monthly", "yearly", "once"])),
  startsPeriod: Period,
  endsPeriod: v.optional(v.nullable(Period)),
  note: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(500)))),
});

// Contract positions: what a customer buys. The recurring price model that the
// billing engine turns into per-period charges.
export const contractsRouter = {
  list: authed
    .input(v.optional(v.object({ customerId: v.optional(v.string()) })))
    .handler(async ({ input }) => {
      const rows = await db
        .select({
          id: contractPositions.id,
          customerId: contractPositions.customerId,
          customerName: customers.name,
          resourceId: contractPositions.resourceId,
          resourceName: resources.name,
          label: contractPositions.label,
          quantity: contractPositions.quantity,
          unitPriceCents: contractPositions.unitPriceCents,
          interval: contractPositions.interval,
          startsPeriod: contractPositions.startsPeriod,
          endsPeriod: contractPositions.endsPeriod,
          note: contractPositions.note,
        })
        .from(contractPositions)
        .leftJoin(customers, eq(customers.id, contractPositions.customerId))
        .leftJoin(resources, eq(resources.id, contractPositions.resourceId))
        .orderBy(
          asc(customers.name),
          asc(contractPositions.startsPeriod),
          asc(contractPositions.label),
        );
      return input?.customerId ? rows.filter((r) => r.customerId === input.customerId) : rows;
    }),

  upsert: authed.input(PositionInput).handler(async ({ input }) => {
    if (input.endsPeriod && input.endsPeriod < input.startsPeriod) {
      throw new ORPCError("VALIDATION_FAILED", { message: "Ende muss nach dem Beginn liegen" });
    }
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!customer) throw new ORPCError("NOT_FOUND", { message: "Kunde nicht gefunden" });

    const values = {
      customerId: input.customerId,
      resourceId: input.resourceId ?? null,
      label: input.label,
      quantity: input.quantity ?? 1,
      unitPriceCents: input.unitPriceCents,
      interval: input.interval ?? ("monthly" as const),
      startsPeriod: input.startsPeriod,
      endsPeriod: input.endsPeriod ?? null,
      note: input.note ?? null,
    };
    if (input.id) {
      const [row] = await db
        .update(contractPositions)
        .set(values)
        .where(eq(contractPositions.id, input.id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Position nicht gefunden" });
      return row;
    }
    const [row] = await db.insert(contractPositions).values(values).returning();
    return row!;
  }),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    await db.delete(contractPositions).where(eq(contractPositions.id, input.id));
    return { ok: true };
  }),
};
