// Billing service: the DB-backed side of tenant billing. Loads the period's
// inventory, cost and price rows once and hands them to the pure engines in
// costs/margin.ts and costs/billing.ts. Shared by the oRPC router, the MCP
// server and the worker so every surface reports the same numbers.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  type BillingReadiness,
  buildStatements,
  type CustomerStatement,
  type OwnerSuggestion,
  resolveCharges,
  resourceCostMap,
  suggestOwners,
  type UnassignedResource,
} from "../costs/billing";
import { type MarginSummary, periodOf, rollupMargin } from "../costs/margin";
import { db } from "../db";
import {
  contractPositions,
  costAllocations,
  customerPricing,
  providerCosts,
} from "../db/schema/costs";
import { customers } from "../db/schema/customers";
import { resources } from "../db/schema/resources";
import { assignOwnerWithHistory } from "../resources/history";

// Resource types whose external id is a domain name a customer can own. They
// anchor domain-based owner suggestions for everything living under them.
const DOMAIN_TYPES = ["domain", "registered_domain", "dns_zone", "mail_domain", "ses_identity"];

// Provider (who we pay) and internal (that's us) are not billable tenants: their
// cost is overhead, not a losing customer.
const OVERHEAD_KINDS = new Set(["provider", "internal"]);

async function loadPeriodRows(period: string) {
  const [customerRows, resourceRows, allocRows, poolRows, positionRows, adjustmentRows] =
    await Promise.all([
      db
        .select({ id: customers.id, name: customers.name, kind: customers.kind })
        .from(customers)
        .orderBy(asc(customers.name)),
      db
        .select({
          id: resources.id,
          type: resources.type,
          provider: resources.provider,
          externalId: resources.externalId,
          name: resources.name,
          ownerCustomerId: resources.ownerCustomerId,
          parentResourceId: resources.parentResourceId,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(eq(resources.status, "active"))
        .orderBy(asc(resources.provider), asc(resources.type), asc(resources.name)),
      db.select().from(costAllocations).where(eq(costAllocations.period, period)),
      db.select().from(providerCosts).where(eq(providerCosts.period, period)),
      // All positions; the engine decides which bill in this period.
      db.select().from(contractPositions).orderBy(asc(contractPositions.label)),
      db
        .select({
          customerId: customerPricing.customerId,
          period: customerPricing.period,
          amountCents: customerPricing.amountCents,
          note: customerPricing.note,
        })
        .from(customerPricing)
        .where(eq(customerPricing.period, period)),
    ]);
  return { customerRows, resourceRows, allocRows, poolRows, positionRows, adjustmentRows };
}

export interface MarginReport extends MarginSummary {
  period: string;
}

/**
 * Per-customer cost vs charge vs margin for a period. Charges come from contract
 * positions plus one-off adjustments. Unowned cost, uncovered pools, and
 * provider/internal customers roll into overhead; all-zero rows are dropped.
 */
export async function loadMarginReport(period = periodOf(new Date())): Promise<MarginReport> {
  const { customerRows, resourceRows, allocRows, poolRows, positionRows, adjustmentRows } =
    await loadPeriodRows(period);
  const charges = resolveCharges(period, positionRows, adjustmentRows);

  const summary = rollupMargin({
    customers: customerRows.map((c) => ({ id: c.id, name: c.name })),
    resourceOwner: new Map(resourceRows.map((r) => [r.id, r.ownerCustomerId])),
    allocations: allocRows.map((a) => ({
      resourceId: a.resourceId,
      mode: a.mode,
      amountCents: a.amountCents,
      weight: a.weight,
      providerCostId: a.providerCostId,
    })),
    pools: poolRows.map((p) => ({ id: p.id, amountCents: p.amountCents })),
    pricing: [...charges].map(([customerId, c]) => ({ customerId, amountCents: c.amountCents })),
  });

  // A pool no allocation references (a second provider pool the allocator ignores,
  // or an orphan) would otherwise vanish from the totals. Count it as overhead so
  // money always reconciles to what you pay.
  const allocatedPoolIds = new Set(
    allocRows.map((a) => a.providerCostId).filter((x): x is string => Boolean(x)),
  );
  const uncoveredPoolCents = poolRows
    .filter((p) => !allocatedPoolIds.has(p.id))
    .reduce((s, p) => s + p.amountCents, 0);

  const kindById = new Map(customerRows.map((c) => [c.id, c.kind]));
  let overheadCents = summary.unallocatedCostCents + uncoveredPoolCents;
  const rows = summary.rows
    .filter((r) => {
      if (OVERHEAD_KINDS.has(kindById.get(r.customerId) ?? "")) {
        overheadCents += r.costCents;
        return false;
      }
      return r.costCents !== 0 || r.chargeCents !== 0;
    })
    .sort((a, b) => a.marginCents - b.marginCents);

  const totalCostCents = summary.totalCostCents + uncoveredPoolCents;
  return {
    period,
    ...summary,
    rows,
    totalCostCents,
    unallocatedCostCents: overheadCents,
    totalMarginCents: summary.totalChargeCents - totalCostCents,
  };
}

/** One statement per customer: owned resources with cost, effective price, margin. */
export async function loadStatements(
  period = periodOf(new Date()),
): Promise<{ period: string; statements: CustomerStatement[] }> {
  const { customerRows, resourceRows, allocRows, poolRows, positionRows, adjustmentRows } =
    await loadPeriodRows(period);
  return {
    period,
    statements: buildStatements({
      period,
      customers: customerRows,
      resources: resourceRows,
      allocations: allocRows,
      pools: poolRows,
      positions: positionRows,
      adjustments: adjustmentRows,
    }),
  };
}

/**
 * The pre-billing check: which resources still lack an owner (and what they
 * cost), who bills nothing despite drawing cost, and which pools sit idle.
 * `ready` is true when nothing needs a human before invoicing.
 */
export async function loadReadiness(period = periodOf(new Date())): Promise<BillingReadiness> {
  const { customerRows, resourceRows, allocRows, poolRows, positionRows, adjustmentRows } =
    await loadPeriodRows(period);
  const cost = resourceCostMap(allocRows, poolRows);
  const customerName = new Map(customerRows.map((c) => [c.id, c.name]));
  const resourceName = new Map(resourceRows.map((r) => [r.id, r.name]));

  const suggestions = new Map(
    computeSuggestions(resourceRows, customerRows).map((s) => [s.resourceId, s]),
  );
  const unassigned: UnassignedResource[] = resourceRows
    .filter((r) => r.ownerCustomerId == null)
    .map((r) => {
      const s = suggestions.get(r.id) ?? null;
      return {
        id: r.id,
        type: r.type,
        provider: r.provider,
        name: r.name,
        parentResourceId: r.parentResourceId,
        parentName: r.parentResourceId ? (resourceName.get(r.parentResourceId) ?? null) : null,
        costCents: cost.get(r.id) ?? 0,
        suggestion: s ? { ...s, customerName: customerName.get(s.customerId) ?? "" } : null,
      };
    })
    .sort((a, b) => b.costCents - a.costCents || a.name.localeCompare(b.name));

  const statements = buildStatements({
    period,
    customers: customerRows,
    resources: resourceRows,
    allocations: allocRows,
    pools: poolRows,
    positions: positionRows,
    adjustments: adjustmentRows,
  });
  const unpriced = statements
    .filter((s) => s.billable && s.costCents > 0 && s.revenueLines.length === 0)
    .map((s) => ({ customerId: s.customerId, name: s.name, costCents: s.costCents }));

  const allocatedPoolIds = new Set(
    allocRows.map((a) => a.providerCostId).filter((x): x is string => Boolean(x)),
  );
  const uncoveredPools = poolRows
    .filter((p) => !allocatedPoolIds.has(p.id))
    .map((p) => ({ id: p.id, provider: p.provider, label: p.label, amountCents: p.amountCents }));

  return {
    period,
    unassigned,
    unassignedCostCents: unassigned.reduce((s, r) => s + r.costCents, 0),
    unpriced,
    uncoveredPools,
    ready: unassigned.every((r) => r.costCents === 0) && unpriced.length === 0,
  };
}

type ResourceRow = Awaited<ReturnType<typeof loadPeriodRows>>["resourceRows"][number];

function computeSuggestions(
  resourceRows: ResourceRow[],
  customerRows: { id: string; name: string }[],
): OwnerSuggestion[] {
  const domainOwner = new Map<string, string>();
  const ownerById = new Map<string, { customerId: string; type: string }>();
  for (const r of resourceRows) {
    if (!r.ownerCustomerId) continue;
    ownerById.set(r.id, { customerId: r.ownerCustomerId, type: r.type });
    if (DOMAIN_TYPES.includes(r.type))
      domainOwner.set(r.externalId.toLowerCase(), r.ownerCustomerId);
  }
  return suggestOwners({
    resources: resourceRows.filter((r) => r.ownerCustomerId == null),
    domainOwner,
    ownerById,
    customers: customerRows,
  });
}

export interface AppliedSuggestion extends OwnerSuggestion {
  resourceName: string;
  customerName: string;
}

/**
 * Assign suggested owners. With `resourceIds` only those resources are touched
 * (operator picked them); without, every suggestion at or above `minConfidence`
 * is applied (the worker's autonomous pass uses "high" only). Railway services
 * follow their project, matching resources.assignOwner.
 */
export async function applyOwnerSuggestions(options: {
  resourceIds?: string[];
  minConfidence?: "high" | "medium";
  /** Who is acting: "user:<email>", "worker", "mcp:<token>". Written to the audit trail. */
  actor: string;
}): Promise<AppliedSuggestion[]> {
  const [customerRows, resourceRows] = await Promise.all([
    db.select({ id: customers.id, name: customers.name }).from(customers),
    db
      .select({
        id: resources.id,
        type: resources.type,
        provider: resources.provider,
        externalId: resources.externalId,
        name: resources.name,
        ownerCustomerId: resources.ownerCustomerId,
        parentResourceId: resources.parentResourceId,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(eq(resources.status, "active")),
  ]);
  const wanted = options.resourceIds ? new Set(options.resourceIds) : null;
  const min = options.minConfidence ?? "high";
  const picked = computeSuggestions(resourceRows, customerRows).filter((s) => {
    if (wanted) return wanted.has(s.resourceId);
    return min === "medium" || s.confidence === "high";
  });
  if (picked.length === 0) return [];

  // Group by target customer so each group is one audited assignment. Only
  // still-unowned rows are touched, so a concurrent manual assignment wins.
  const byCustomer = new Map<string, string[]>();
  for (const s of picked) {
    const list = byCustomer.get(s.customerId);
    if (list) list.push(s.resourceId);
    else byCustomer.set(s.customerId, [s.resourceId]);
  }
  for (const [customerId, resourceIds] of byCustomer) {
    await assignOwnerWithHistory({
      resourceIds,
      customerId,
      actor: options.actor,
      onlyUnowned: true,
    });
  }

  const resourceName = new Map(resourceRows.map((r) => [r.id, r.name]));
  const customerName = new Map(customerRows.map((c) => [c.id, c.name]));
  return picked.map((s) => ({
    ...s,
    resourceName: resourceName.get(s.resourceId) ?? s.resourceId,
    customerName: customerName.get(s.customerId) ?? s.customerId,
  }));
}

/** Count of unowned resources, for the dashboard badge. Cheap. */
export async function countUnassigned(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(resources)
    .where(and(isNull(resources.ownerCustomerId), eq(resources.status, "active")));
  return row?.n ?? 0;
}
