import { eq } from "drizzle-orm";
import type { CheckResult } from "../connectors/types";
import { db } from "../db";
import { assets, checkResults } from "../db/schema/assets";
import { applyIncidentTransition, isSuppressed } from "../incidents/service";
import { notifyIncidentChange } from "../notifications/incidents";

// Shared by the worker (probe results) and the ingest endpoint (pushed results):
// append a history row, update the asset's denormalized current state, and
// open/close incidents on status transitions.
export async function persistCheckResult(
  assetId: string,
  result: CheckResult,
  at: Date = new Date(),
): Promise<void> {
  // Read prior state before overwriting it, to detect the transition.
  const [prev] = await db
    .select({
      status: assets.lastStatus,
      mutedUntil: assets.mutedUntil,
      customerId: assets.customerId,
    })
    .from(assets)
    .where(eq(assets.id, assetId));

  await db.transaction(async (tx) => {
    await tx.insert(checkResults).values({
      assetId,
      status: result.status,
      latencyMs: result.latencyMs,
      message: result.message,
      metadata: result.raw,
      checkedAt: at,
    });
    await tx
      .update(assets)
      .set({
        lastStatus: result.status,
        lastLatencyMs: result.latencyMs,
        lastCheckedAt: at,
      })
      .where(eq(assets.id, assetId));
  });

  // Incident tracking is derived/best-effort: never fail a check over it.
  if (prev) {
    try {
      const suppressed = await isSuppressed(assetId, prev.customerId, prev.mutedUntil, at);
      const change = await applyIncidentTransition(
        assetId,
        prev.status,
        result.status,
        at,
        suppressed,
      );
      // Tell the operator right away; the daily digest only covers the slow
      // signals (expiry, dead worker, incomplete billing month).
      await notifyIncidentChange(assetId, change, result.message, at);
    } catch (error) {
      console.error("[persist] incident transition failed", assetId, (error as Error)?.message);
    }
  }
}
