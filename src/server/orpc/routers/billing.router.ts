import * as v from "valibot";
import {
  applyOwnerSuggestions,
  countUnassigned,
  loadReadiness,
  loadStatements,
} from "../../billing/service";
import { periodOf } from "../../costs/margin";
import { authed } from "../base";

const Period = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM"));
const PeriodInput = v.optional(v.object({ period: v.optional(Period) }));

// Tenant billing: the pre-invoice check (unassigned resources, customers that
// bill nothing, idle pools), per-customer statements, and owner suggestions.
export const billingRouter = {
  readiness: authed
    .input(PeriodInput)
    .handler(({ input }) => loadReadiness(input?.period ?? periodOf(new Date()))),

  statements: authed
    .input(PeriodInput)
    .handler(({ input }) => loadStatements(input?.period ?? periodOf(new Date()))),

  unassignedCount: authed.handler(() => countUnassigned()),

  // Assign suggested owners. Pass resourceIds to apply a hand-picked subset (any
  // confidence); without it only high-confidence suggestions are applied.
  applySuggestions: authed
    .input(
      v.optional(
        v.object({
          resourceIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(500))),
          minConfidence: v.optional(v.picklist(["high", "medium"])),
        }),
      ),
    )
    .handler(async ({ input, context }) => {
      const applied = await applyOwnerSuggestions({
        resourceIds: input?.resourceIds,
        minConfidence: input?.minConfidence,
        actor: `user:${context.user.email ?? context.user.id}`,
      });
      return { applied };
    }),
};
