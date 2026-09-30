import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { customers } from "../../db/schema/customers";
import { maintenanceWindows } from "../../db/schema/maintenance";
import { authed } from "../base";

const CreateInput = v.object({
  assetId: v.optional(v.nullable(v.string())),
  customerId: v.optional(v.nullable(v.string())),
  startsAt: v.string(),
  endsAt: v.string(),
  reason: v.optional(v.nullable(v.string())),
});

export const maintenanceRouter = {
  list: authed.handler(async () => {
    return db
      .select({
        id: maintenanceWindows.id,
        assetId: maintenanceWindows.assetId,
        assetName: assets.name,
        customerId: maintenanceWindows.customerId,
        locationName: customers.name,
        startsAt: maintenanceWindows.startsAt,
        endsAt: maintenanceWindows.endsAt,
        reason: maintenanceWindows.reason,
      })
      .from(maintenanceWindows)
      .leftJoin(assets, eq(maintenanceWindows.assetId, assets.id))
      .leftJoin(customers, eq(maintenanceWindows.customerId, customers.id))
      .orderBy(desc(maintenanceWindows.startsAt));
  }),

  create: authed.input(CreateInput).handler(async ({ input }) => {
    if (!input.assetId && !input.customerId) {
      throw new ORPCError("VALIDATION_FAILED", { message: "Prüfung oder Kunde auswählen" });
    }
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new ORPCError("VALIDATION_FAILED", { message: "Ungültiger Zeitraum" });
    }
    if (endsAt <= startsAt) {
      throw new ORPCError("VALIDATION_FAILED", { message: "Ende muss nach dem Beginn liegen" });
    }
    const [row] = await db
      .insert(maintenanceWindows)
      .values({
        assetId: input.assetId ?? null,
        customerId: input.customerId ?? null,
        startsAt,
        endsAt,
        reason: input.reason ?? null,
      })
      .returning();
    return row!;
  }),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, input.id));
    return { ok: true };
  }),
};
