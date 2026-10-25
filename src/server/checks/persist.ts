import { eq } from "drizzle-orm";
import type { CheckResult } from "../connectors/types";
import { db } from "../db";
import { assets, checkResults } from "../db/schema/assets";

// Shared by the worker (probe results) and the ingest endpoint (pushed results):
// append a history row, update the asset's denormalized current state, and
// retain source synchronization results without incident or alarm delivery.
export async function persistCheckResult(
  assetId: string,
  result: CheckResult,
  at: Date = new Date(),
): Promise<void> {
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
}
