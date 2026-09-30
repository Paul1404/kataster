import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { incidents } from "../../db/schema/incidents";
import { authed } from "../base";

export const incidentsRouter = {
  list: authed
    .input(
      v.optional(
        v.object({
          assetId: v.optional(v.string()),
          openOnly: v.optional(v.boolean()),
          limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(500)), 100),
        }),
      ),
    )
    .handler(async ({ input }) => {
      const filters = [];
      if (input?.assetId) filters.push(eq(incidents.assetId, input.assetId));
      if (input?.openOnly) filters.push(isNull(incidents.endedAt));
      return db
        .select({
          id: incidents.id,
          assetId: incidents.assetId,
          assetName: assets.name,
          status: incidents.status,
          startedAt: incidents.startedAt,
          endedAt: incidents.endedAt,
          acknowledgedAt: incidents.acknowledgedAt,
          acknowledgedBy: incidents.acknowledgedBy,
          note: incidents.note,
        })
        .from(incidents)
        .leftJoin(assets, eq(incidents.assetId, assets.id))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(incidents.startedAt))
        .limit(input?.limit ?? 100);
    }),

  acknowledge: authed
    .input(v.object({ id: v.string(), note: v.optional(v.nullable(v.string())) }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(incidents)
        .set({
          acknowledgedAt: new Date(),
          acknowledgedBy: context.user.name ?? context.user.email ?? context.user.id,
          note: input.note ?? null,
        })
        .where(eq(incidents.id, input.id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Störung nicht gefunden" });
      return row;
    }),
};
