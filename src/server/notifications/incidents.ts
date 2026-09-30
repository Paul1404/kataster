/**
 * Real-time incident notifications. Called straight after the incident
 * transition in `persistCheckResult`, so an outage is announced within one
 * check interval instead of waiting for the daily digest.
 *
 * Server-only. Never throws: a broken webhook must not fail a check.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { assets } from "../db/schema/assets";
import type { IncidentChange } from "../incidents/service";
import { deliverEvents } from "./deliver";
import {
  buildNotificationEvents,
  type IncidentEventInput,
  type NotificationState,
  WORKER_DEAD_AFTER_MS,
} from "./events";
import { loadActiveRules } from "./rules";

function emptyState(now: Date): NotificationState {
  return {
    now,
    openIncidents: [],
    resolvedIncidents: [],
    expiring: [],
    workerLastSeenAt: now,
    workerDeadAfterMs: WORKER_DEAD_AFTER_MS,
    billing: null,
  };
}

export async function notifyIncidentChange(
  assetId: string,
  change: IncidentChange,
  message: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (change.type === "none") return;
  try {
    const kind = change.type === "opened" ? "incident_opened" : "incident_resolved";
    const rules = await loadActiveRules([kind]);
    if (rules.length === 0) return;

    const [asset] = await db
      .select({ name: assets.name })
      .from(assets)
      .where(eq(assets.id, assetId));
    const incident: IncidentEventInput = {
      incidentId: change.incidentId,
      assetName: asset?.name ?? assetId,
      status: change.type === "opened" ? change.status : "down",
      startedAt: change.startedAt,
      endedAt: change.type === "resolved" ? change.endedAt : null,
      message,
    };

    const state = emptyState(now);
    if (change.type === "opened") state.openIncidents = [incident];
    else state.resolvedIncidents = [incident];

    await deliverEvents(buildNotificationEvents(state, rules));
  } catch (error) {
    console.error("[notify] incident notification failed", assetId, (error as Error)?.message);
  }
}
