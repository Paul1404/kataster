import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { CheckStatus } from "../connectors/types";
import { db } from "../db";
import { incidents } from "../db/schema/incidents";
import { maintenanceWindows } from "../db/schema/maintenance";

export type IncidentAction =
  | { type: "open"; status: "down" | "degraded" }
  | { type: "escalate"; status: "down" | "degraded" }
  | { type: "close" }
  | { type: "none" };

const RANK: Record<CheckStatus, number> = { up: 0, unknown: 1, degraded: 2, down: 3 };
const isUnhealthy = (s: CheckStatus) => s === "down" || s === "degraded";

/**
 * Pure incident decision from a status transition.
 * - recovery (-> up) closes any open incident
 * - healthy -> unhealthy opens one (unless suppressed by mute/maintenance)
 * - unhealthy -> unhealthy escalates severity (e.g. degraded -> down)
 * - transitions to/from unknown never open or close (avoids transient noise)
 */
export function incidentAction(
  prev: CheckStatus,
  next: CheckStatus,
  suppressed: boolean,
): IncidentAction {
  if (next === "up") return { type: "close" };
  if (isUnhealthy(next)) {
    if (isUnhealthy(prev)) return { type: "escalate", status: next };
    return suppressed ? { type: "none" } : { type: "open", status: next };
  }
  return { type: "none" };
}

/** True if the asset is muted or covered by an active maintenance window. */
export async function isSuppressed(
  assetId: string,
  customerId: string | null,
  mutedUntil: Date | null,
  now: Date,
): Promise<boolean> {
  if (mutedUntil && mutedUntil.getTime() > now.getTime()) return true;
  const scope = customerId
    ? or(eq(maintenanceWindows.assetId, assetId), eq(maintenanceWindows.customerId, customerId))
    : eq(maintenanceWindows.assetId, assetId);
  const [win] = await db
    .select({ id: maintenanceWindows.id })
    .from(maintenanceWindows)
    .where(and(scope, lte(maintenanceWindows.startsAt, now), gte(maintenanceWindows.endsAt, now)))
    .limit(1);
  return Boolean(win);
}

/**
 * What actually changed in the database. Notifications are driven off this, so
 * "opened" / "resolved" is reported only when a row was really written (a
 * no-op close on an already-healthy asset stays silent).
 */
export type IncidentChange =
  | { type: "opened"; incidentId: string; status: "down" | "degraded"; startedAt: Date }
  | { type: "resolved"; incidentId: string; startedAt: Date; endedAt: Date }
  | { type: "none" };

/** Apply an incident transition: open / close / escalate the asset's open incident. */
export async function applyIncidentTransition(
  assetId: string,
  prev: CheckStatus,
  next: CheckStatus,
  at: Date,
  suppressed: boolean,
): Promise<IncidentChange> {
  const action = incidentAction(prev, next, suppressed);
  switch (action.type) {
    case "open": {
      // The partial-unique index guarantees at most one open incident per asset.
      const [row] = await db
        .insert(incidents)
        .values({ assetId, status: action.status, startedAt: at })
        .onConflictDoNothing()
        .returning({ id: incidents.id, startedAt: incidents.startedAt });
      return row
        ? { type: "opened", incidentId: row.id, status: action.status, startedAt: row.startedAt }
        : { type: "none" };
    }
    case "close": {
      const [row] = await db
        .update(incidents)
        .set({ endedAt: at })
        .where(and(eq(incidents.assetId, assetId), isNull(incidents.endedAt)))
        .returning({ id: incidents.id, startedAt: incidents.startedAt });
      return row
        ? { type: "resolved", incidentId: row.id, startedAt: row.startedAt, endedAt: at }
        : { type: "none" };
    }
    case "escalate": {
      await db
        .update(incidents)
        .set({ status: action.status })
        .where(
          and(
            eq(incidents.assetId, assetId),
            isNull(incidents.endedAt),
            sql`${RANK[action.status]} > ${sql.raw(rankCase())}`,
          ),
        );
      return { type: "none" };
    }
    default:
      return { type: "none" };
  }
}

// SQL CASE that maps the incident's current status to its rank, so we only
// escalate (never downgrade) the stored severity.
function rankCase(): string {
  return `case incidents.status when 'down' then 3 when 'degraded' then 2 when 'unknown' then 1 else 0 end`;
}
