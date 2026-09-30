import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { customerRelations } from "../../db/schema/customers";
import { authed } from "../base";

const RelationType = v.picklist(["depends_on", "feeds", "connects", "monitors"]);

export const relationsRouter = {
  list: authed.handler(async () => {
    return db.select().from(customerRelations).orderBy(desc(customerRelations.createdAt));
  }),

  create: authed
    .input(
      v.object({
        fromCustomerId: v.pipe(v.string(), v.minLength(1)),
        toCustomerId: v.pipe(v.string(), v.minLength(1)),
        type: v.optional(RelationType),
        label: v.optional(v.nullable(v.string())),
      }),
    )
    .handler(async ({ input }) => {
      if (input.fromCustomerId === input.toCustomerId) {
        throw new ORPCError("VALIDATION_FAILED", {
          message: "Ein Kunde kann nicht mit sich selbst verbunden werden",
        });
      }
      const [row] = await db
        .insert(customerRelations)
        .values({
          fromCustomerId: input.fromCustomerId,
          toCustomerId: input.toCustomerId,
          type: input.type ?? "connects",
          label: input.label ?? null,
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    }),

  // Hub-and-spoke: connect one location to many others in a single action.
  createMany: authed
    .input(
      v.object({
        fromCustomerId: v.pipe(v.string(), v.minLength(1)),
        toLocationIds: v.array(v.string()),
        type: v.optional(RelationType),
      }),
    )
    .handler(async ({ input }) => {
      const targets = input.toLocationIds.filter((id) => id && id !== input.fromCustomerId);
      if (targets.length === 0) return { created: 0 };
      const rows = await db
        .insert(customerRelations)
        .values(
          targets.map((toCustomerId) => ({
            fromCustomerId: input.fromCustomerId,
            toCustomerId,
            type: input.type ?? "connects",
          })),
        )
        .onConflictDoNothing()
        .returning();
      return { created: rows.length };
    }),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    await db.delete(customerRelations).where(eq(customerRelations.id, input.id));
    return { ok: true };
  }),
};
