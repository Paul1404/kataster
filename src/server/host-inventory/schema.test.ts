import { describe, expect, it } from "vitest";
import { parseHostSnapshot, summarizeHost } from "./schema";

const now = new Date("2026-10-25T12:00:00Z");
const snapshot = {
  hostname: "host.example.test",
  observedAt: now.toISOString(),
  os: "Rocky Linux 10",
  mailboxes: [{ address: "user@example.test", name: "User", usedBytes: 100 }],
  containers: [
    {
      name: "site-db",
      site: "site",
      domain: "example.test",
      state: "running",
      image: "sha256:example",
    },
  ],
  backup: {
    lastSuccessAt: now.toISOString(),
    snapshotId: "12345678",
    accountCount: 1,
    packedBytes: 123,
  },
};
describe("authoritative host inventory", () => {
  it("rejects stale, future, duplicate and secret-bearing snapshots before reconciliation", () => {
    for (const change of [
      { observedAt: "2026-10-24T12:00:00Z" },
      { observedAt: "2026-10-26T12:00:00Z" },
      { mailboxes: [...snapshot.mailboxes, ...snapshot.mailboxes] },
      { token: "never store credentials in inventory" },
    ])
      expect(() => parseHostSnapshot({ ...snapshot, ...change }, now)).toThrow();
  });
  it("does not report unknown costs as a complete healthy source", () => {
    expect(summarizeHost(parseHostSnapshot(snapshot, now), now)).toMatchObject({
      status: "degraded",
      raw: { missingCosts: true },
    });
    expect(
      summarizeHost(
        parseHostSnapshot({ ...snapshot, hostMonthlyCents: 1000, backupMonthlyCents: 100 }, now),
        now,
      ).status,
    ).toBe("up");
  });
  it("marks stale cached data unknown instead of pretending the host was freshly observed", () => {
    expect(
      summarizeHost(parseHostSnapshot(snapshot, now), new Date("2026-10-25T13:00:00Z")).status,
    ).toBe("unknown");
  });
});
