import { describe, expect, it } from "vitest";
import { AWS_COST_REFRESH_INTERVAL_MS, isAwsCostRefreshDue, splitDnsCost } from "./ingest";

describe("isAwsCostRefreshDue", () => {
  const now = new Date("2026-07-21T12:00:00Z");

  it("refreshes when no successful cost ingestion exists", () => {
    expect(isAwsCostRefreshDue(null, now)).toBe(true);
  });

  it("suppresses the paid API call for 24 hours", () => {
    const recent = new Date(now.getTime() - AWS_COST_REFRESH_INTERVAL_MS + 1);
    expect(isAwsCostRefreshDue(recent, now)).toBe(false);
  });

  it("refreshes once the daily interval has elapsed", () => {
    const due = new Date(now.getTime() - AWS_COST_REFRESH_INTERVAL_MS);
    expect(isAwsCostRefreshDue(due, now)).toBe(true);
  });

  it("does not refresh for a future timestamp", () => {
    expect(isAwsCostRefreshDue(new Date("2026-07-22T12:00:00Z"), now)).toBe(false);
  });
});

describe("splitDnsCost", () => {
  it("splits the hosted-zone charge evenly and the KSK charge across signed zones only", () => {
    const out = splitDnsCost({
      zones: [
        { name: "a.de", dnssecEnabled: true },
        { name: "b.de", dnssecEnabled: true },
        { name: "c.de", dnssecEnabled: false },
        { name: "internal.", private: true, dnssecEnabled: false },
      ],
      route53Cents: 150, // 3 public zones -> 50 each
      kmsCents: 200, // 2 signed zones -> 100 each
    });
    expect(out).toEqual([
      { zone: "a.de", cents: 150 },
      { zone: "b.de", cents: 150 },
      { zone: "c.de", cents: 50 },
    ]);
  });

  it("adds back up to the bill, so nothing is invented or lost", () => {
    const out = splitDnsCost({
      zones: [
        { name: "a.de", dnssecEnabled: true },
        { name: "b.de", dnssecEnabled: false },
      ],
      route53Cents: 101,
      kmsCents: 99,
    });
    expect(out.reduce((a, b) => a + b.cents, 0)).toBe(200);
  });

  it("charges nothing for DNSSEC when no zone is signed", () => {
    const out = splitDnsCost({
      zones: [{ name: "a.de", dnssecEnabled: false }],
      route53Cents: 50,
      kmsCents: 0,
    });
    expect(out).toEqual([{ zone: "a.de", cents: 50 }]);
  });

  it("ignores private zones entirely", () => {
    expect(
      splitDnsCost({ zones: [{ name: "x.", private: true }], route53Cents: 50, kmsCents: 0 }),
    ).toEqual([]);
  });
});
