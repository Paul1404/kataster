// Pure billing helpers on top of the margin engine. No DB access: the billing
// service feeds rows in, these functions decide what a tenant costs, what they
// pay, which resources still lack an owner, and who probably owns them.

import { matchTenantToCustomer, nameTokens } from "../resources/map";
import { type AllocationInput, type PoolInput, resolveAllocationsCents } from "./margin";

// --- Charges: contract positions + one-off adjustments ---------------------

export type BillingInterval = "monthly" | "yearly" | "once";

export interface ContractPositionRow {
  id: string;
  customerId: string;
  resourceId: string | null;
  label: string;
  quantity: number;
  unitPriceCents: number;
  interval: BillingInterval;
  startsPeriod: string; // 'YYYY-MM' inclusive
  endsPeriod: string | null; // 'YYYY-MM' inclusive, null = open-ended
}

/** One-off adjustment for exactly one period (credit, setup fee, correction). */
export interface AdjustmentRow {
  customerId: string;
  period: string;
  amountCents: number;
  note: string | null;
}

export interface RevenueLine {
  kind: "position" | "adjustment";
  id: string | null;
  label: string;
  resourceId: string | null;
  quantity: number;
  unitPriceCents: number;
  interval: BillingInterval | null;
  /** What this line contributes to the period, in cents. */
  amountCents: number;
}

/** True when a position bills in the given period. */
export function positionActive(p: ContractPositionRow, period: string): boolean {
  if (p.interval === "once") return p.startsPeriod === period;
  if (period < p.startsPeriod) return false;
  if (p.endsPeriod && period > p.endsPeriod) return false;
  return true;
}

/** Cents a position contributes to one period. Yearly spreads across 12 months. */
export function positionAmountForPeriod(p: ContractPositionRow, period: string): number {
  if (!positionActive(p, period)) return 0;
  const total = Math.round(p.quantity * p.unitPriceCents);
  if (p.interval === "yearly") return Math.round(total / 12);
  return total;
}

/**
 * Resolve every customer's charge for a period from the contract positions
 * active in it plus the period's one-off adjustments. Periods compare lexically
 * because they are zero-padded 'YYYY-MM'.
 */
export function resolveCharges(
  period: string,
  positions: ContractPositionRow[],
  adjustments: AdjustmentRow[],
): Map<string, { amountCents: number; lines: RevenueLine[] }> {
  const out = new Map<string, { amountCents: number; lines: RevenueLine[] }>();
  const bucket = (customerId: string) => {
    let b = out.get(customerId);
    if (!b) {
      b = { amountCents: 0, lines: [] };
      out.set(customerId, b);
    }
    return b;
  };
  for (const p of positions) {
    const amountCents = positionAmountForPeriod(p, period);
    if (!positionActive(p, period)) continue;
    const b = bucket(p.customerId);
    b.amountCents += amountCents;
    b.lines.push({
      kind: "position",
      id: p.id,
      label: p.label,
      resourceId: p.resourceId,
      quantity: p.quantity,
      unitPriceCents: p.unitPriceCents,
      interval: p.interval,
      amountCents,
    });
  }
  for (const a of adjustments) {
    if (a.period !== period || a.amountCents === 0) continue;
    const b = bucket(a.customerId);
    b.amountCents += a.amountCents;
    b.lines.push({
      kind: "adjustment",
      id: null,
      label: a.note?.trim() || "Einmalposten",
      resourceId: null,
      quantity: 1,
      unitPriceCents: a.amountCents,
      interval: null,
      amountCents: a.amountCents,
    });
  }
  return out;
}

// --- Per-resource cost --------------------------------------------------------

/** Resolve every allocation of a period to cents, keyed by resource. */
export function resourceCostMap(
  allocations: AllocationInput[],
  pools: PoolInput[],
): Map<string, number> {
  const resolved = resolveAllocationsCents(allocations, pools);
  const out = new Map<string, number>();
  for (const [i, alloc] of allocations.entries()) {
    const cents = resolved[i]!;
    if (cents === 0) continue;
    out.set(alloc.resourceId, (out.get(alloc.resourceId) ?? 0) + cents);
  }
  return out;
}

// --- Owner suggestions ----------------------------------------------------------

export interface SuggestionResource {
  id: string;
  type: string;
  name: string;
  externalId: string;
  parentResourceId: string | null;
  metadata: Record<string, unknown>;
}

export interface OwnerSuggestion {
  resourceId: string;
  customerId: string;
  /** high: derived from an owned domain or parent; medium: name similarity only. */
  confidence: "high" | "medium";
  /** Short machine-readable reason, e.g. "domain:example.de", "parent", "name". */
  reason: string;
}

/** Hostnames a resource is reachable under, for domain-based owner matching. */
export function resourceHostnames(r: SuggestionResource): string[] {
  const hosts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.includes(".") && !v.includes(" ")) hosts.push(v.toLowerCase());
  };
  switch (r.type) {
    case "container": {
      const list = r.metadata.hosts;
      if (Array.isArray(list)) for (const h of list) push(h);
      break;
    }
    case "mailbox": {
      const at = r.externalId.lastIndexOf("@");
      if (at >= 0) push(r.externalId.slice(at + 1));
      break;
    }
    case "cloudfront_distribution": {
      const aliases = r.metadata.aliases;
      if (Array.isArray(aliases)) for (const a of aliases) push(a);
      push(r.name);
      break;
    }
    case "railway_project":
    case "railway_service":
    case "ses_tenant":
      break;
    default:
      push(r.externalId);
      push(r.name);
  }
  return [...new Set(hosts)];
}

/** Walk a hostname up its labels and return the first owned domain hit. */
function matchDomain(
  hosts: string[],
  domainOwner: Map<string, string>,
): { domain: string; customerId: string } | null {
  for (const host of hosts) {
    const labels = host.replace(/^www\./, "").split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const domain = labels.slice(i).join(".");
      const customerId = domainOwner.get(domain);
      if (customerId) return { domain, customerId };
    }
  }
  return null;
}

// Parents whose owner a child may inherit. A host is shared infrastructure: its
// (usually internal) owner says nothing about who the containers on it belong to.
const INHERITABLE_PARENT_TYPES = new Set(["railway_project", "domain", "mail_domain", "dns_zone"]);

/**
 * Suggest an owner for each unassigned resource. Order of evidence:
 *  1. one of its hostnames sits under a domain a customer owns -> high
 *  2. the parent resource has an owner and is an ownership-bearing parent (a
 *     service under a project, a mailbox under a domain; never a host) -> high
 *  3. its name shares distinctive tokens with exactly one customer -> medium
 * Resources without any evidence get no suggestion; leaving a resource
 * unassigned is better than billing the wrong tenant.
 */
export function suggestOwners(input: {
  resources: SuggestionResource[];
  /** domain name -> owning customer id, for every domain-like resource with an owner. */
  domainOwner: Map<string, string>;
  /** resource id -> owner + type of every owned resource, to inherit from a parent. */
  ownerById: Map<string, { customerId: string; type: string }>;
  customers: { id: string; name: string; kind?: string }[];
}): OwnerSuggestion[] {
  // A provider is someone we pay, never a tenant who can own a resource. Handing a
  // resource to one silently moves real customer cost into overhead, where nobody
  // looks for it, so a provider is never a suggestion -- not by name, not inherited
  // from a domain or parent. Evidence pointing at a provider is treated as no
  // evidence, and the next rule gets its turn.
  const providerIds = new Set(
    input.customers.filter((c) => c.kind === "provider").map((c) => c.id),
  );
  const nameCandidates = input.customers.filter((c) => !providerIds.has(c.id));

  const out: OwnerSuggestion[] = [];
  for (const r of input.resources) {
    const hit = matchDomain(resourceHostnames(r), input.domainOwner);
    if (hit && !providerIds.has(hit.customerId)) {
      out.push({
        resourceId: r.id,
        customerId: hit.customerId,
        confidence: "high",
        reason: `domain:${hit.domain}`,
      });
      continue;
    }
    const parent = r.parentResourceId ? input.ownerById.get(r.parentResourceId) : undefined;
    if (
      parent &&
      INHERITABLE_PARENT_TYPES.has(parent.type) &&
      !providerIds.has(parent.customerId)
    ) {
      out.push({
        resourceId: r.id,
        customerId: parent.customerId,
        confidence: "high",
        reason: "parent",
      });
      continue;
    }
    if (nameTokens(r.name).length === 0) continue;
    const byName = matchTenantToCustomer(r.name, nameCandidates);
    if (byName) {
      out.push({ resourceId: r.id, customerId: byName, confidence: "medium", reason: "name" });
    }
  }
  return out;
}

// --- Statements -------------------------------------------------------------------

/** Customer kinds that receive an invoice. Providers and internal records are overhead. */
export const BILLABLE_KINDS = new Set(["customer_private", "customer_business", "partner"]);

export interface StatementLine {
  resourceId: string;
  name: string;
  type: string;
  provider: string;
  costCents: number;
}

export interface CustomerStatement {
  customerId: string;
  name: string;
  kind: string;
  billable: boolean;
  costCents: number;
  chargeCents: number;
  marginCents: number;
  /** What the customer pays this period: positions and one-off adjustments. */
  revenueLines: RevenueLine[];
  lines: StatementLine[];
  /** Resources owned by this customer that draw no cost this period. */
  freeResourceCount: number;
}

/**
 * One statement per customer for a period: every owned resource with the cost it
 * drew, the revenue lines that bill in the period, and the margin. Sorted
 * billable-first, then by margin ascending so losses surface at the top.
 */
export function buildStatements(input: {
  period: string;
  customers: { id: string; name: string; kind: string }[];
  resources: {
    id: string;
    name: string;
    type: string;
    provider: string;
    ownerCustomerId: string | null;
  }[];
  allocations: AllocationInput[];
  pools: PoolInput[];
  positions: ContractPositionRow[];
  adjustments: AdjustmentRow[];
}): CustomerStatement[] {
  const cost = resourceCostMap(input.allocations, input.pools);
  const charges = resolveCharges(input.period, input.positions, input.adjustments);
  const byOwner = new Map<string, typeof input.resources>();
  for (const r of input.resources) {
    if (!r.ownerCustomerId) continue;
    const list = byOwner.get(r.ownerCustomerId);
    if (list) list.push(r);
    else byOwner.set(r.ownerCustomerId, [r]);
  }

  const statements = input.customers.map((c): CustomerStatement => {
    const owned = byOwner.get(c.id) ?? [];
    const lines: StatementLine[] = [];
    let freeResourceCount = 0;
    for (const r of owned) {
      const cents = cost.get(r.id) ?? 0;
      if (cents === 0) {
        freeResourceCount += 1;
        continue;
      }
      lines.push({
        resourceId: r.id,
        name: r.name,
        type: r.type,
        provider: r.provider,
        costCents: cents,
      });
    }
    lines.sort((a, b) => b.costCents - a.costCents);
    const costCents = lines.reduce((s, l) => s + l.costCents, 0);
    const charge = charges.get(c.id);
    const chargeCents = charge?.amountCents ?? 0;
    return {
      customerId: c.id,
      name: c.name,
      kind: c.kind,
      billable: BILLABLE_KINDS.has(c.kind),
      costCents,
      chargeCents,
      marginCents: chargeCents - costCents,
      revenueLines: charge?.lines ?? [],
      lines,
      freeResourceCount,
    };
  });

  return statements.sort((a, b) => {
    if (a.billable !== b.billable) return a.billable ? -1 : 1;
    return a.marginCents - b.marginCents;
  });
}

// --- Readiness -----------------------------------------------------------------

export interface UnassignedResource {
  id: string;
  type: string;
  provider: string;
  name: string;
  parentResourceId: string | null;
  /** Name of the parent CI (the host a container runs on, the project of a service). */
  parentName: string | null;
  /** Cost this resource draws this period and that currently lands in overhead. */
  costCents: number;
  suggestion: (OwnerSuggestion & { customerName: string }) | null;
}

export interface BillingReadiness {
  period: string;
  unassigned: UnassignedResource[];
  unassignedCostCents: number;
  /** Billable customers that draw cost but bill nothing this period. */
  unpriced: { customerId: string; name: string; costCents: number }[];
  /** Pools no allocation draws from: money nobody is attributed. */
  uncoveredPools: { id: string; provider: string; label: string; amountCents: number }[];
  ready: boolean;
}
