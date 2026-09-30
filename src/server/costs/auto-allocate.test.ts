import { describe, expect, it } from "vitest";
import { type AutoResource, computeAutoAllocations, resourceWeight } from "./auto-allocate";

const pool = (id: string, provider: string, resourceId: string | null = null) => ({
  id,
  provider,
  resourceId,
});
const res = (
  id: string,
  provider: string,
  type: string,
  weight: number,
  parentResourceId: string | null = null,
): AutoResource => ({
  id,
  provider,
  type,
  weight,
  parentResourceId,
});

describe("computeAutoAllocations", () => {
  it("splits a pool across containers weighted by usage, normalized to sum 1", () => {
    const out = computeAutoAllocations({
      pools: [pool("h", "hetzner")],
      resources: [res("a", "hetzner", "container", 300), res("b", "hetzner", "container", 100)],
    });
    const by = new Map(out.map((o) => [o.resourceId, o]));
    expect(by.get("a")!.weight).toBeCloseTo(0.75);
    expect(by.get("b")!.weight).toBeCloseTo(0.25);
    expect(out.every((o) => o.providerCostId === "h")).toBe(true);
    expect(out.reduce((s, o) => s + o.weight, 0)).toBeCloseTo(1);
  });

  it("splits evenly when no resource has a usage signal", () => {
    const out = computeAutoAllocations({
      pools: [pool("h", "hetzner")],
      resources: [res("a", "hetzner", "container", 0), res("b", "hetzner", "container", 0)],
    });
    expect(out.map((o) => o.weight)).toEqual([0.5, 0.5]);
  });

  it("gives a signal-less resource its peers' average rather than zero", () => {
    const out = computeAutoAllocations({
      pools: [pool("h", "hetzner")],
      resources: [
        res("a", "hetzner", "container", 100),
        res("b", "hetzner", "container", 100),
        res("c", "hetzner", "container", 0), // no stats -> average (100)
      ],
    });
    const by = new Map(out.map((o) => [o.resourceId, o]));
    // eff weights 100,100,100 -> each 1/3
    expect(by.get("c")!.weight).toBeCloseTo(1 / 3);
    expect(out.reduce((s, o) => s + o.weight, 0)).toBeCloseTo(1);
  });

  it("excludes the vps and railway_project aggregates", () => {
    const out = computeAutoAllocations({
      pools: [pool("h", "hetzner"), pool("r", "railway")],
      resources: [
        res("box", "hetzner", "vps", 1),
        res("c", "hetzner", "container", 50),
        res("proj", "railway", "railway_project", 1),
        res("svc", "railway", "railway_service", 1),
      ],
    });
    const ids = out.map((o) => o.resourceId).sort();
    expect(ids).toEqual(["c", "svc"]);
  });

  it("splits a resource-scoped pool across its children, not the parent", () => {
    // A Railway project pool (resourceId = the project) must land on the project's
    // services, never on the project resource itself (which carries no owner).
    const out = computeAutoAllocations({
      pools: [pool("rproj", "railway", "proj1")],
      resources: [
        res("proj1", "railway", "railway_project", 1),
        res("s1", "railway", "railway_service", 1, "proj1"),
        res("s2", "railway", "railway_service", 1, "proj1"),
      ],
    });
    const ids = out.map((o) => o.resourceId).sort();
    expect(ids).toEqual(["s1", "s2"]);
    expect(out.every((o) => o.providerCostId === "rproj")).toBe(true);
    expect(out.reduce((s, o) => s + o.weight, 0)).toBeCloseTo(1);
  });

  it("ignores providers with no pool", () => {
    const out = computeAutoAllocations({
      pools: [pool("h", "hetzner")],
      resources: [res("x", "aws", "cloudfront_distribution", 1)],
    });
    expect(out).toEqual([]);
  });

  it("uses the first pool when a provider has several", () => {
    const out = computeAutoAllocations({
      pools: [pool("h1", "hetzner"), pool("h2", "hetzner")],
      resources: [res("c", "hetzner", "container", 10)],
    });
    expect(out[0]!.providerCostId).toBe("h1");
  });

  it("host-scoped pool splits across only that host's containers by RAM", () => {
    const out = computeAutoAllocations({
      pools: [pool("hp", "hetzner", "host1")],
      resources: [
        res("box", "hetzner", "host", 1), // the host CI itself is excluded
        res("c1", "hetzner", "container", 300, "host1"),
        res("c2", "hetzner", "container", 100, "host1"),
        res("other", "hetzner", "container", 50, "host2"), // a different host
      ],
    });
    const by = new Map(out.map((o) => [o.resourceId, o]));
    expect(by.get("c1")!.weight).toBeCloseTo(0.75);
    expect(by.get("c2")!.weight).toBeCloseTo(0.25);
    expect(by.has("other")).toBe(false); // not this host's child, no provider pool
    expect(out.every((o) => o.providerCostId === "hp")).toBe(true);
  });

  it("provider pool skips resources already claimed by a host pool (no double-alloc)", () => {
    const out = computeAutoAllocations({
      pools: [pool("hp", "hetzner", "host1"), pool("pp", "aws", null)],
      resources: [
        res("c1", "hetzner", "container", 100, "host1"), // claimed by host pool
        res("cf", "aws", "cloudfront_distribution", 1), // aws provider pool
      ],
    });
    const by = new Map(out.map((o) => [o.resourceId, o]));
    expect(by.get("c1")!.providerCostId).toBe("hp");
    expect(by.get("cf")!.providerCostId).toBe("pp");
    expect(out.length).toBe(2);
  });

  it("host pool splits across a supplied served-set (mail host -> mailboxes)", () => {
    const mb1 = res("mb1", "mailcow", "mailbox", 1);
    const mb2 = res("mb2", "mailcow", "mailbox", 1);
    const out = computeAutoAllocations({
      pools: [pool("mp", "hetzner", "mailhost")],
      resources: [mb1, mb2],
      hostServed: new Map([["mailhost", [mb1, mb2]]]),
    });
    const by = new Map(out.map((o) => [o.resourceId, o]));
    expect(by.get("mb1")!.weight).toBeCloseTo(0.5);
    expect(by.get("mb2")!.weight).toBeCloseTo(0.5);
    expect(out.every((o) => o.providerCostId === "mp")).toBe(true);
  });

  it("host pool with a self served-set puts the whole pool on the host (infra box -> owner)", () => {
    const hostRes = res("opshost", "other", "host", 1);
    const out = computeAutoAllocations({
      pools: [pool("op", "hetzner", "opshost")],
      resources: [hostRes],
      hostServed: new Map([["opshost", [hostRes]]]),
    });
    expect(out).toEqual([{ resourceId: "opshost", providerCostId: "op", weight: 1 }]);
  });

  it("a pool scoped to a leaf lands on that leaf, not its children", () => {
    // A Route 53 zone pool is scoped to its Domain CI; the domain's mailboxes are
    // children of the domain but pay for the mail host, not for DNS.
    const mb1 = res("mb1", "mailcow", "mailbox", 1, "dom");
    const mb2 = res("mb2", "mailcow", "mailbox", 1, "dom");
    const out = computeAutoAllocations({
      pools: [pool("mail", "hetzner", "mailhost"), pool("dns", "aws", "dom"), pool("acct", "aws")],
      resources: [
        res("dom", "aws", "domain", 1),
        res("cf", "aws", "cloudfront_distribution", 1),
        mb1,
        mb2,
      ],
      hostServed: new Map([["mailhost", [mb1, mb2]]]),
    });
    const by = new Map(out.map((o) => [o.resourceId, o.providerCostId]));
    expect(by.get("dom")).toBe("dns");
    expect(by.get("mb1")).toBe("mail");
    expect(by.get("mb2")).toBe("mail");
    // The account pool only covers what no scoped pool already charged.
    expect(by.get("cf")).toBe("acct");
    expect(out.find((o) => o.resourceId === "dom")!.weight).toBe(1);
  });

  it("never emits two allocations for one resource", () => {
    // Two aggregate pools that both claim the same served resource: the second
    // one must skip it, or the (resource, period) upsert fails as a whole.
    const mb = res("mb", "mailcow", "mailbox", 1);
    const out = computeAutoAllocations({
      pools: [pool("a", "hetzner", "h1"), pool("b", "hetzner", "h2")],
      resources: [mb],
      hostServed: new Map([
        ["h1", [mb]],
        ["h2", [mb]],
      ]),
    });
    expect(out).toEqual([{ resourceId: "mb", providerCostId: "a", weight: 1 }]);
  });
});

describe("resourceWeight", () => {
  it("prefers memory, then cpu, then zero for containers", () => {
    expect(resourceWeight("container", { memBytes: 1024, cpuPercent: 5 })).toBe(1024);
    expect(resourceWeight("container", { memBytes: null, cpuPercent: 5 })).toBe(5);
    expect(resourceWeight("container", { memBytes: null, cpuPercent: null })).toBe(0);
  });

  it("gives non-container leaf resources an even weight of 1", () => {
    expect(resourceWeight("railway_service", {})).toBe(1);
    expect(resourceWeight("cloudfront_distribution", {})).toBe(1);
  });
});
