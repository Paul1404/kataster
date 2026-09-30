import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema/customers";
import { resourceHistory, resources } from "../db/schema/resources";

type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type Executor = typeof db | Tx;

export interface HistoryEntry {
  resourceId: string;
  field: "owner" | "status" | "name";
  oldValue: string | null;
  newValue: string | null;
}

/** Append audit rows. Values are human-readable (customer names, not ids). */
export async function recordResourceHistory(
  entries: HistoryEntry[],
  actor: string,
  executor: Executor = db,
): Promise<void> {
  const rows = entries.filter((e) => e.oldValue !== e.newValue);
  if (rows.length === 0) return;
  await executor.insert(resourceHistory).values(rows.map((e) => ({ ...e, actor })));
}

/**
 * Set the owner of resources and record who did it. Railway services follow
 * their project. Only rows whose owner actually changes produce history.
 * With `onlyUnowned`, resources that already have an owner are left alone (the
 * worker's autonomous path must never override a human decision).
 */
export async function assignOwnerWithHistory(input: {
  resourceIds: string[];
  customerId: string | null;
  actor: string;
  onlyUnowned?: boolean;
}): Promise<number> {
  if (input.resourceIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const services = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          inArray(resources.parentResourceId, input.resourceIds),
          eq(resources.type, "railway_service"),
        ),
      );
    const ids = [...new Set([...input.resourceIds, ...services.map((s) => s.id)])];
    const before = await tx
      .select({
        id: resources.id,
        ownerCustomerId: resources.ownerCustomerId,
        ownerName: customers.name,
      })
      .from(resources)
      .leftJoin(customers, eq(customers.id, resources.ownerCustomerId))
      .where(
        input.onlyUnowned
          ? and(inArray(resources.id, ids), isNull(resources.ownerCustomerId))
          : inArray(resources.id, ids),
      );
    const targets = before.filter((r) => r.ownerCustomerId !== input.customerId);
    if (targets.length === 0) return 0;

    let newName: string | null = null;
    if (input.customerId) {
      const [c] = await tx
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1);
      newName = c?.name ?? input.customerId;
    }
    await tx
      .update(resources)
      .set({ ownerCustomerId: input.customerId })
      .where(
        inArray(
          resources.id,
          targets.map((t) => t.id),
        ),
      );
    await recordResourceHistory(
      targets.map((t) => ({
        resourceId: t.id,
        field: "owner" as const,
        oldValue: t.ownerName ?? null,
        newValue: newName,
      })),
      input.actor,
      tx,
    );
    return targets.length;
  });
}

/** Flip lifecycle status and record it. */
export async function setResourceStatus(input: {
  resourceIds: string[];
  status: "active" | "decommissioned";
  actor: string;
}): Promise<number> {
  if (input.resourceIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const before = await tx
      .select({ id: resources.id, status: resources.status })
      .from(resources)
      .where(inArray(resources.id, input.resourceIds));
    const targets = before.filter((r) => r.status !== input.status);
    if (targets.length === 0) return 0;
    await tx
      .update(resources)
      .set({ status: input.status })
      .where(
        inArray(
          resources.id,
          targets.map((t) => t.id),
        ),
      );
    await recordResourceHistory(
      targets.map((t) => ({
        resourceId: t.id,
        field: "status" as const,
        oldValue: t.status,
        newValue: input.status,
      })),
      input.actor,
      tx,
    );
    return targets.length;
  });
}
