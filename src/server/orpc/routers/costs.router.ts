import { ORPCError } from "@orpc/server";
import { asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";
import { loadMarginReport } from "../../billing/service";
import { refreshAutoAllocations } from "../../costs/auto-allocate";
import { AWS_COST_LABEL, AWS_DNS_LABEL_PREFIX } from "../../costs/ingest";
import { periodOf, resolveAllocationsCents } from "../../costs/margin";
import { db } from "../../db";
import { costAllocations, customerPricing, providerCosts } from "../../db/schema/costs";
import { resources } from "../../db/schema/resources";
import { authed } from "../base";

const Period = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM"));
const Provider = v.picklist(["aws", "hetzner", "railway", "mailcow", "other"]);

// The stored label is the upsert key of a synced pool and stays as it is; only
// the display is German. A resource-scoped pool (a Railway project, a Hetzner
// host, a DNS zone) shows its resource's name, never an opaque label.
export function poolDisplayLabel(label: string, resourceName: string | null): string {
  if (label === AWS_COST_LABEL) return "AWS-Konto (übrige Dienste)";
  return resourceName ?? label;
}

export const costsRouter = {
  // --- Provider cost pools (the totals you pay each provider per month) ---
  pools: {
    list: authed
      .input(v.optional(v.object({ period: v.optional(Period) })))
      .handler(async ({ input }) => {
        const period = input?.period ?? periodOf(new Date());
        const rows = await db
          .select({
            id: providerCosts.id,
            provider: providerCosts.provider,
            period: providerCosts.period,
            label: providerCosts.label,
            source: providerCosts.source,
            amountCents: providerCosts.amountCents,
            currency: providerCosts.currency,
            resourceId: providerCosts.resourceId,
            resourceName: resources.name,
            // Outer column spelled out: Drizzle renders ${providerCosts.id}
            // unqualified here, which would bind to cost_allocations.id.
            allocationCount: sql<number>`(
              select count(*)::int from cost_allocations ca
              where ca.provider_cost_id = "provider_costs"."id"
            )`,
          })
          .from(providerCosts)
          .leftJoin(resources, eq(resources.id, providerCosts.resourceId))
          .where(eq(providerCosts.period, period))
          .orderBy(asc(providerCosts.provider), asc(providerCosts.label));
        return rows.map(({ resourceName, ...r }) => ({
          ...r,
          displayLabel: poolDisplayLabel(r.label, resourceName),
          // Route 53 zone pools are shown as one expandable DNS group per period.
          group: r.label.startsWith(`${AWS_DNS_LABEL_PREFIX} `) ? ("dns" as const) : null,
          // Metered pools are written by a connector sync; deleting one by hand
          // only lasts until the next sync, so the UI offers delete for manual
          // pools only and the server refuses the rest.
          managed: r.source === "metered",
        }));
      }),
    upsert: authed
      .input(
        v.object({
          provider: Provider,
          period: Period,
          label: v.pipe(v.string(), v.minLength(1)),
          source: v.optional(v.picklist(["metered", "fixed"])),
          amountCents: v.pipe(v.number(), v.integer(), v.minValue(0)),
          currency: v.optional(v.string()),
        }),
      )
      .handler(async ({ input }) => {
        const [row] = await db
          .insert(providerCosts)
          .values({
            provider: input.provider,
            period: input.period,
            label: input.label,
            source: input.source ?? "fixed",
            amountCents: input.amountCents,
            currency: input.currency ?? "EUR",
          })
          .onConflictDoUpdate({
            target: [providerCosts.provider, providerCosts.period, providerCosts.label],
            set: {
              amountCents: input.amountCents,
              source: input.source ?? "fixed",
              currency: input.currency ?? "EUR",
            },
          })
          .returning();
        return row!;
      }),
    remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
      const [pool] = await db
        .select({ source: providerCosts.source })
        .from(providerCosts)
        .where(eq(providerCosts.id, input.id));
      if (!pool) throw new ORPCError("NOT_FOUND", { message: "Kostenpool nicht gefunden" });
      if (pool.source === "metered") {
        throw new ORPCError("BAD_REQUEST", {
          message: "Dieser Pool kommt aus einem Anbieter-Abgleich und lässt sich nicht löschen.",
        });
      }
      await db.delete(providerCosts).where(eq(providerCosts.id, input.id));
      return { ok: true };
    }),
  },

  // --- Per-resource allocations (how each resource draws its cost) ---
  allocations: {
    list: authed.input(v.object({ period: v.optional(Period) })).handler(async ({ input }) => {
      const period = input.period ?? periodOf(new Date());
      const [rows, poolRows] = await Promise.all([
        db.select().from(costAllocations).where(eq(costAllocations.period, period)),
        db
          .select({ id: providerCosts.id, amountCents: providerCosts.amountCents })
          .from(providerCosts)
          .where(eq(providerCosts.period, period)),
      ]);
      // The euro amount each row actually draws, resolved exactly as the margin
      // rollup does, so the list adds up to the tiles above it.
      const cents = resolveAllocationsCents(rows, poolRows);
      return rows.map((r, i) => ({ ...r, cents: cents[i]! }));
    }),
    upsert: authed
      .input(
        v.object({
          resourceId: v.string(),
          period: Period,
          mode: v.picklist(["fixed", "weighted"]),
          amountCents: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
          weight: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
          providerCostId: v.optional(v.nullable(v.string())),
        }),
      )
      .handler(async ({ input }) => {
        const [row] = await db
          .insert(costAllocations)
          .values({
            resourceId: input.resourceId,
            period: input.period,
            mode: input.mode,
            amountCents: input.amountCents ?? null,
            weight: input.weight ?? null,
            providerCostId: input.providerCostId ?? null,
            auto: false,
          })
          .onConflictDoUpdate({
            target: [costAllocations.resourceId, costAllocations.period],
            set: {
              mode: input.mode,
              amountCents: input.amountCents ?? null,
              weight: input.weight ?? null,
              providerCostId: input.providerCostId ?? null,
              // A hand edit takes the row out of the auto-allocator's control.
              auto: false,
            },
          })
          .returning();
        // Re-split the pools now: the resource just left (or joined) the
        // automatic split, and the next sync may be 15 minutes away.
        await refreshAutoAllocations(input.period);
        return row!;
      }),
    // Hands a resource back to the auto-allocator: drops its manual row and
    // re-splits the period, so it draws its automatic share right away.
    remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
      const [row] = await db
        .delete(costAllocations)
        .where(eq(costAllocations.id, input.id))
        .returning({ period: costAllocations.period });
      if (row) await refreshAutoAllocations(row.period);
      return { ok: true };
    }),
  },

  // --- What we charge each customer ---
  pricing: {
    upsert: authed
      .input(
        v.object({
          customerId: v.string(),
          period: Period,
          amountCents: v.pipe(v.number(), v.integer(), v.minValue(0)),
          note: v.optional(v.nullable(v.string())),
        }),
      )
      .handler(async ({ input }) => {
        const [row] = await db
          .insert(customerPricing)
          .values({
            customerId: input.customerId,
            period: input.period,
            amountCents: input.amountCents,
            note: input.note ?? null,
          })
          .onConflictDoUpdate({
            target: [customerPricing.customerId, customerPricing.period],
            set: { amountCents: input.amountCents, note: input.note ?? null },
          })
          .returning();
        return row!;
      }),
  },

  // --- The payoff: per-customer cost vs charge vs margin for a period ---
  // Shared with the MCP server and the billing page so every surface agrees.
  summary: authed
    .input(v.optional(v.object({ period: v.optional(Period) })))
    .handler(({ input }) => loadMarginReport(input?.period ?? periodOf(new Date()))),
};
