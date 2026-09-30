import { describe, expect, it } from "vitest";
import {
  buildStatements,
  resolveCharges,
  resourceCostMap,
  resourceHostnames,
  suggestOwners,
} from "./billing";

describe("resolveCharges", () => {
  const pos = (over: Partial<import("./billing").ContractPositionRow>) => ({
    id: "p",
    customerId: "a",
    resourceId: null,
    label: "Hosting",
    quantity: 1,
    unitPriceCents: 1000,
    interval: "monthly" as const,
    startsPeriod: "2026-07",
    endsPeriod: null,
    ...over,
  });

  it("bills monthly positions from their start, quantity times unit price", () => {
    const m = resolveCharges("2026-09", [pos({ quantity: 5, unitPriceCents: 200 })], []);
    expect(m.get("a")?.amountCents).toBe(1000);
    expect(m.get("a")?.lines[0]?.kind).toBe("position");
    expect(resolveCharges("2026-06", [pos({})], []).has("a")).toBe(false);
  });

  it("respects the end period and spreads yearly over twelve months", () => {
    expect(resolveCharges("2026-09", [pos({ endsPeriod: "2026-08" })], []).has("a")).toBe(false);
    expect(
      resolveCharges("2026-08", [pos({ endsPeriod: "2026-08" })], []).get("a")?.amountCents,
    ).toBe(1000);
    expect(
      resolveCharges("2026-09", [pos({ interval: "yearly", unitPriceCents: 12000 })], []).get("a")
        ?.amountCents,
    ).toBe(1000);
  });

  it("bills once positions only in their start period and adds adjustments", () => {
    const once = pos({ interval: "once", startsPeriod: "2026-09", unitPriceCents: 5000 });
    expect(resolveCharges("2026-10", [once], []).has("a")).toBe(false);
    const m = resolveCharges(
      "2026-09",
      [once],
      [{ customerId: "a", period: "2026-09", amountCents: -500, note: "Gutschrift" }],
    );
    expect(m.get("a")?.amountCents).toBe(4500);
    expect(m.get("a")?.lines.map((l) => l.label)).toEqual(["Hosting", "Gutschrift"]);
  });
});

describe("resourceCostMap", () => {
  it("resolves fixed and weighted allocations per resource", () => {
    const m = resourceCostMap(
      [
        { resourceId: "r1", mode: "fixed", amountCents: 500, weight: null, providerCostId: null },
        { resourceId: "r2", mode: "weighted", amountCents: null, weight: 0.5, providerCostId: "p" },
        { resourceId: "r3", mode: "weighted", amountCents: null, weight: 0, providerCostId: "p" },
      ],
      [{ id: "p", amountCents: 1000 }],
    );
    expect(m.get("r1")).toBe(500);
    expect(m.get("r2")).toBe(500);
    expect(m.has("r3")).toBe(false);
  });
});

describe("resourceHostnames", () => {
  it("derives hostnames per resource type", () => {
    expect(
      resourceHostnames({
        id: "c",
        type: "container",
        name: "wp",
        externalId: "web/wp",
        parentResourceId: null,
        metadata: { hosts: ["www.Example.de", "shop.example.de"] },
      }),
    ).toEqual(["www.example.de", "shop.example.de"]);
    expect(
      resourceHostnames({
        id: "m",
        type: "mailbox",
        name: "info@example.de",
        externalId: "info@example.de",
        parentResourceId: null,
        metadata: {},
      }),
    ).toEqual(["example.de"]);
    expect(
      resourceHostnames({
        id: "p",
        type: "railway_project",
        name: "kontor2",
        externalId: "p1",
        parentResourceId: null,
        metadata: {},
      }),
    ).toEqual([]);
  });
});

describe("suggestOwners", () => {
  const customers = [
    { id: "cust-a", name: "Kulturzentrum Musterhausen" },
    { id: "cust-b", name: "Wengertsberg Verein" },
  ];
  const domainOwner = new Map([["example.de", "cust-a"]]);

  it("inherits from an ownership-bearing parent", () => {
    const [s] = suggestOwners({
      resources: [
        {
          id: "svc",
          type: "railway_service",
          name: "api",
          externalId: "s1",
          parentResourceId: "proj",
          metadata: {},
        },
      ],
      domainOwner,
      ownerById: new Map([["proj", { customerId: "cust-b", type: "railway_project" }]]),
      customers,
    });
    expect(s).toEqual({
      resourceId: "svc",
      customerId: "cust-b",
      confidence: "high",
      reason: "parent",
    });
  });

  it("walks subdomains up to an owned domain, beating a shared host parent", () => {
    const [s] = suggestOwners({
      resources: [
        {
          id: "c",
          type: "container",
          name: "shop",
          externalId: "web/shop",
          parentResourceId: "host",
          metadata: { hosts: ["shop.staging.example.de"] },
        },
      ],
      domainOwner,
      ownerById: new Map([["host", { customerId: "cust-internal", type: "host" }]]),
      customers,
    });
    expect(s).toEqual({
      resourceId: "c",
      customerId: "cust-a",
      confidence: "high",
      reason: "domain:example.de",
    });
  });

  it("never inherits a host's owner", () => {
    const out = suggestOwners({
      resources: [
        {
          id: "c",
          type: "container",
          name: "matomo",
          externalId: "web/matomo",
          parentResourceId: "host",
          metadata: { hosts: ["stats.unknown.tld"] },
        },
      ],
      domainOwner,
      ownerById: new Map([["host", { customerId: "cust-internal", type: "host" }]]),
      customers,
    });
    expect(out).toEqual([]);
  });

  it("never suggests a provider, and falls through to the next rule instead", () => {
    // A provider owning a domain must not drag everything under it into overhead.
    const out = suggestOwners({
      resources: [
        {
          id: "mbx",
          type: "mailbox",
          name: "info",
          externalId: "info@example.de",
          parentResourceId: "dom",
          metadata: {},
        },
      ],
      domainOwner: new Map([["example.de", "cust-provider"]]),
      ownerById: new Map([["dom", { customerId: "cust-provider", type: "domain" }]]),
      customers: [
        ...customers,
        { id: "cust-provider", name: "Amazon Web Services", kind: "provider" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("still suggests an internal owner: that is us, not someone we pay", () => {
    const out = suggestOwners({
      resources: [
        {
          id: "mbx",
          type: "mailbox",
          name: "info",
          externalId: "info@intern.de",
          parentResourceId: null,
          metadata: {},
        },
      ],
      domainOwner: new Map([["intern.de", "cust-internal"]]),
      ownerById: new Map(),
      customers: [...customers, { id: "cust-internal", name: "PDCD", kind: "internal" }],
    });
    expect(out[0]?.customerId).toBe("cust-internal");
  });

  it("falls back to a confident name match, else nothing", () => {
    const out = suggestOwners({
      resources: [
        {
          id: "t",
          type: "ses_tenant",
          name: "Tenant-Kulturzentrum-Musterhausen",
          externalId: "t1",
          parentResourceId: null,
          metadata: {},
        },
        {
          id: "x",
          type: "ses_tenant",
          name: "Tenant-Services",
          externalId: "t2",
          parentResourceId: null,
          metadata: {},
        },
      ],
      domainOwner,
      ownerById: new Map(),
      customers,
    });
    expect(out).toEqual([
      { resourceId: "t", customerId: "cust-a", confidence: "medium", reason: "name" },
    ]);
  });
});

describe("buildStatements", () => {
  it("lines up owned resources with their cost and carried-forward price", () => {
    const statements = buildStatements({
      period: "2026-09",
      customers: [
        { id: "a", name: "Alpha", kind: "customer_business" },
        { id: "i", name: "Us", kind: "internal" },
      ],
      resources: [
        { id: "r1", name: "alpha.de", type: "domain", provider: "aws", ownerCustomerId: "a" },
        { id: "r2", name: "wp", type: "container", provider: "hetzner", ownerCustomerId: "a" },
        { id: "r3", name: "free", type: "mailbox", provider: "mailcow", ownerCustomerId: "a" },
        { id: "r4", name: "ops", type: "host", provider: "other", ownerCustomerId: "i" },
        { id: "r5", name: "lost", type: "container", provider: "hetzner", ownerCustomerId: null },
      ],
      allocations: [
        { resourceId: "r1", mode: "fixed", amountCents: 100, weight: null, providerCostId: null },
        { resourceId: "r2", mode: "weighted", amountCents: null, weight: 0.5, providerCostId: "p" },
        { resourceId: "r4", mode: "fixed", amountCents: 700, weight: null, providerCostId: null },
        { resourceId: "r5", mode: "fixed", amountCents: 300, weight: null, providerCostId: null },
      ],
      pools: [{ id: "p", amountCents: 1000 }],
      positions: [
        {
          id: "pos",
          customerId: "a",
          resourceId: null,
          label: "Pauschale",
          quantity: 1,
          unitPriceCents: 2000,
          interval: "monthly",
          startsPeriod: "2026-08",
          endsPeriod: null,
        },
      ],
      adjustments: [],
    });

    expect(statements.map((s) => s.customerId)).toEqual(["a", "i"]);
    const a = statements[0]!;
    expect(a.billable).toBe(true);
    expect(a.lines.map((l) => [l.resourceId, l.costCents])).toEqual([
      ["r2", 500],
      ["r1", 100],
    ]);
    expect(a.freeResourceCount).toBe(1);
    expect(a.costCents).toBe(600);
    expect(a.chargeCents).toBe(2000);
    expect(a.marginCents).toBe(1400);
    expect(a.revenueLines).toHaveLength(1);
    const i = statements[1]!;
    expect(i.billable).toBe(false);
    expect(i.costCents).toBe(700);
    expect(i.revenueLines).toEqual([]);
  });
});
