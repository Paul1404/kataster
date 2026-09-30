import { describe, expect, it } from "vitest";
import { mailEdgeId } from "./edge";
import { buildMailEventRows, type MailEventContext } from "./events-sync";
import type { RspamdRecord } from "./rspamd";

const SERVER = "loc-server";
const CUST_A = "loc-a";

function ctx(overrides: Partial<MailEventContext> = {}): MailEventContext {
  return {
    serverCustomerId: SERVER,
    domainLocation: new Map<string, string | null>([
      ["a.com", CUST_A],
      ["unplaced.com", null],
    ]),
    ...overrides,
  };
}

function rec(over: Partial<RspamdRecord> = {}): RspamdRecord {
  return {
    messageId: "m1",
    sender: "ext@outside.com",
    recipients: ["bob@a.com"],
    user: null,
    action: "no action",
    score: 1,
    sizeBytes: 1000,
    occurredAtMs: 10_000,
    ...over,
  };
}

describe("buildMailEventRows", () => {
  it("classifies an authenticated submission as outbound on the sender's domain", () => {
    const { rows } = buildMailEventRows(
      "asset1",
      [rec({ sender: "alice@a.com", user: "alice@a.com", recipients: ["ext@outside.com"] })],
      ctx(),
      0,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "outbound",
      domainName: "a.com",
      endpointCustomerId: CUST_A,
      serverCustomerId: SERVER,
      recipient: "ext@outside.com",
    });
  });

  it("classifies external -> local recipient as inbound", () => {
    const { rows } = buildMailEventRows("asset1", [rec()], ctx(), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "inbound",
      domainName: "a.com",
      endpointCustomerId: CUST_A,
      sender: "ext@outside.com",
      recipient: "bob@a.com",
    });
  });

  it("fans out one inbound row per local recipient with distinct rcptIndex", () => {
    const { rows } = buildMailEventRows(
      "asset1",
      [rec({ recipients: ["bob@a.com", "carol@a.com", "ext@outside.com"] })],
      ctx(),
      0,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.rcptIndex)).toEqual([0, 1]);
    expect(rows.every((r) => r.direction === "inbound")).toBe(true);
  });

  it("skips records at or before the cursor but still reports the high-water mark", () => {
    const { rows, maxOccurredAtMs } = buildMailEventRows(
      "asset1",
      [rec({ occurredAtMs: 5_000 }), rec({ messageId: "m2", occurredAtMs: 20_000 })],
      ctx(),
      10_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageId).toBe("m2");
    expect(maxOccurredAtMs).toBe(20_000);
  });

  it("stores events for unplaced domains with a null customer location (no edge)", () => {
    const { rows } = buildMailEventRows(
      "asset1",
      [rec({ recipients: ["x@unplaced.com"] })],
      ctx(),
      0,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpointCustomerId).toBeNull();
  });

  it("ignores mail with no local party", () => {
    const { rows } = buildMailEventRows(
      "asset1",
      [rec({ sender: "ext@outside.com", recipients: ["other@elsewhere.com"] })],
      ctx(),
      0,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("mailEdgeId", () => {
  it("matches the derived map edge id format", () => {
    expect(mailEdgeId(SERVER, CUST_A)).toBe(`mail:${SERVER}:${CUST_A}`);
  });
});
