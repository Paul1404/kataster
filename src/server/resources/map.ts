import type { resourceProvider, resourceType } from "../db/schema/resources";

export type ResourceTypeValue = (typeof resourceType.enumValues)[number];
export type ResourceProviderValue = (typeof resourceProvider.enumValues)[number];

// A provider-agnostic resource to upsert. `parentExternalId` is the same-provider
// parent's externalId (resolved to a real parentResourceId in the DB layer).
// `preserveOwner` keeps a manually-set owner instead of overwriting it (used for
// resources with no backing typed table, like SES tenants).
export interface ResourceSeed {
  type: ResourceTypeValue;
  provider: ResourceProviderValue;
  externalId: string;
  name: string;
  ownerCustomerId: string | null;
  parentExternalId: string | null;
  preserveOwner: boolean;
  metadata: Record<string, unknown>;
}

// Generic words that must never drive a match (else "Tenant-Personal-Digital-
// Services" matches "Amazon Web Services…" on "services", etc.).
const STOPWORDS = new Set([
  "tenant",
  "services",
  "service",
  "personal",
  "digital",
  "online",
  "cloud",
  "systems",
  "solutions",
  "group",
  "holding",
  "internal",
  "infrastructure",
  "domains",
  "gmbh",
  "sarl",
]);

// Transliterate German and split into comparable tokens (>=4 chars), dropping
// generic words that would cause false matches.
export function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

// Best-effort SES-tenant -> customer match by name. SES tenant names encode the
// customer (e.g. "Tenant-Kulturzentrum-Musterhausen"). Match the customer with
// the most overlapping tokens, requiring either two shared tokens or one strong
// (>=8 char) shared token. Returns null when no confident match -- better to leave
// a tenant unassigned than to mis-attribute it.
export function matchTenantToCustomer(
  tenantName: string,
  customers: { id: string; name: string }[],
): string | null {
  const tTokens = new Set(nameTokens(tenantName));
  if (tTokens.size === 0) return null;
  let best: { id: string; score: number; strong: boolean } | null = null;
  for (const c of customers) {
    const shared = nameTokens(c.name).filter((t) => tTokens.has(t));
    if (shared.length === 0) continue;
    const strong = shared.some((t) => t.length >= 8);
    const confident = shared.length >= 2 || strong;
    if (!confident) continue;
    if (!best || shared.length > best.score) best = { id: c.id, score: shared.length, strong };
  }
  return best?.id ?? null;
}

interface TenantShape {
  name: string;
  id: string;
  arn: string;
}

/** Pure: SES tenants -> resource seeds, matched to a customer by name. Domain-shaped
 * AWS inventory (dns/registry/ses/cloudfront/acm) is projected as Domain CIs + facets
 * in syncAwsResources instead. */
export function awsTenantSeeds(input: {
  tenants: TenantShape[];
  customers: { id: string; name: string }[];
}): ResourceSeed[] {
  const seeds: ResourceSeed[] = [];
  for (const t of input.tenants) {
    const externalId = t.id || t.arn || t.name;
    if (!externalId) continue;
    seeds.push({
      type: "ses_tenant",
      provider: "aws",
      externalId,
      name: t.name,
      ownerCustomerId: matchTenantToCustomer(t.name, input.customers),
      parentExternalId: null,
      preserveOwner: true,
      metadata: { arn: t.arn, tenantId: t.id },
    });
  }
  return seeds;
}

interface MailboxShape {
  address: string;
  domainName: string;
  customerId: string | null;
  name: string | null;
  active: boolean;
  quotaUsedBytes: number;
}

/**
 * Pure: expand the mailcow typed inventory into resource seeds. A mailbox points
 * to its mail_domain via parentExternalId, but carries its own owner so a single
 * mailbox can belong to a different customer than its domain.
 *
 * preserveOwner is true: `resources` is the single source of truth for ownership
 * (the CMDB), the mailcow table only seeds it. Mirroring instead would let every
 * sync overwrite an owner set in the UI, and the worker's suggestion pass would
 * re-assign it a minute later, thrashing the audit trail once a minute.
 */
export function mailboxResourceSeeds(mailboxes: MailboxShape[]): ResourceSeed[] {
  return mailboxes.map((m) => ({
    type: "mailbox",
    provider: "mailcow",
    externalId: m.address,
    name: m.name ?? m.address,
    ownerCustomerId: m.customerId,
    parentExternalId: m.domainName,
    preserveOwner: true,
    metadata: { domainName: m.domainName, active: m.active, quotaUsedBytes: m.quotaUsedBytes },
  }));
}

interface RailwayProjectShape {
  id: string;
  name: string;
  services: { id: string; name: string }[];
}

/** Pure: turn Railway projects + services into resource seeds (service -> project). */
export function railwayResourceSeeds(projects: RailwayProjectShape[]): ResourceSeed[] {
  const seeds: ResourceSeed[] = [];
  for (const p of projects) {
    seeds.push({
      type: "railway_project",
      provider: "railway",
      externalId: p.id,
      name: p.name,
      ownerCustomerId: null,
      parentExternalId: null,
      preserveOwner: true,
      metadata: {},
    });
    for (const s of p.services) {
      seeds.push({
        type: "railway_service",
        provider: "railway",
        externalId: s.id,
        name: s.name,
        ownerCustomerId: null,
        parentExternalId: p.id,
        preserveOwner: true,
        metadata: { projectId: p.id },
      });
    }
  }
  return seeds;
}
