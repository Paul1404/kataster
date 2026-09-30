import { describe, expect, it } from "vitest";
import {
  buildNotificationEvents,
  formatDuration,
  type NotificationRuleInput,
  type NotificationState,
  WORKER_DEAD_AFTER_MS,
} from "./events";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const CHANNEL = "chan-1";

function rule(
  kind: NotificationRuleInput["kind"],
  thresholdDays: number | null = null,
): NotificationRuleInput {
  return { channelId: CHANNEL, kind, thresholdDays };
}

function state(patch: Partial<NotificationState> = {}): NotificationState {
  return {
    now: NOW,
    openIncidents: [],
    resolvedIncidents: [],
    expiring: [],
    workerLastSeenAt: NOW,
    workerDeadAfterMs: WORKER_DEAD_AFTER_MS,
    billing: null,
    ...patch,
  };
}

describe("formatDuration", () => {
  it("uses whole German units", () => {
    expect(formatDuration(30_000)).toBe("unter 1 min");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3 h 12 min");
    expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2 d 1 h");
  });
});

describe("incident events", () => {
  const incident = {
    incidentId: "inc-1",
    assetName: "mail.example.test",
    status: "down" as const,
    startedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    message: "SMTP timeout nach 5 s",
  };

  it("announces an open incident with the check message and duration", () => {
    const events = buildNotificationEvents(state({ openIncidents: [incident] }), [
      rule("incident_opened"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Ausfall: mail.example.test");
    expect(events[0]!.body).toContain("seit 2 h");
    expect(events[0]!.body).toContain("SMTP timeout nach 5 s");
    expect(events[0]!.ruleKind).toBe("incident_opened");
  });

  it("keys an incident by its id, so a second evaluation dedupes", () => {
    const first = buildNotificationEvents(state({ openIncidents: [incident] }), [
      rule("incident_opened"),
    ]);
    const later = buildNotificationEvents(
      state({ now: new Date(NOW.getTime() + 3_600_000), openIncidents: [incident] }),
      [rule("incident_opened")],
    );
    expect(later[0]!.dedupeKey).toBe(first[0]!.dedupeKey);
    // The text moves on with the outage, the identity does not.
    expect(later[0]!.body).not.toBe(first[0]!.body);
  });

  it("gives resolved a different key than opened for the same incident", () => {
    const opened = buildNotificationEvents(state({ openIncidents: [incident] }), [
      rule("incident_opened"),
    ]);
    const resolved = buildNotificationEvents(
      state({ resolvedIncidents: [{ ...incident, endedAt: NOW }] }),
      [rule("incident_resolved")],
    );
    expect(resolved[0]!.dedupeKey).not.toBe(opened[0]!.dedupeKey);
    expect(resolved[0]!.title).toBe("Wieder erreichbar: mail.example.test");
    expect(resolved[0]!.body).toContain("2 h");
  });

  it("marks a degraded incident differently", () => {
    const events = buildNotificationEvents(
      state({ openIncidents: [{ ...incident, status: "degraded" }] }),
      [rule("incident_opened")],
    );
    expect(events[0]!.title).toBe("Beeinträchtigt: mail.example.test");
  });

  it("stays silent when no rule is enabled", () => {
    expect(buildNotificationEvents(state({ openIncidents: [incident] }), [])).toEqual([]);
  });

  it("sends one copy per channel, with per-channel keys", () => {
    const events = buildNotificationEvents(state({ openIncidents: [incident] }), [
      rule("incident_opened"),
      { channelId: "chan-2", kind: "incident_opened", thresholdDays: null },
    ]);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
  });
});

describe("expiry events", () => {
  const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

  it("fires only inside the threshold", () => {
    const s = state({
      expiring: [
        { kind: "domain", name: "bald.de", expiresAt: inDays(10) },
        { kind: "domain", name: "spaeter.de", expiresAt: inDays(60) },
      ],
    });
    const events = buildNotificationEvents(s, [rule("expiry_soon", 30)]);
    expect(events.map((e) => e.title)).toEqual(["Läuft ab: bald.de"]);
    expect(events[0]!.body).toContain("in 10 Tagen");
  });

  it("keeps one key per object and threshold, and re-arms on a new expiry date", () => {
    const s = state({ expiring: [{ kind: "domain", name: "bald.de", expiresAt: inDays(10) }] });
    const at30 = buildNotificationEvents(s, [rule("expiry_soon", 30)])[0]!;
    const at30Again = buildNotificationEvents(s, [rule("expiry_soon", 30)])[0]!;
    const at14 = buildNotificationEvents(s, [rule("expiry_soon", 14)])[0]!;
    expect(at30Again.dedupeKey).toBe(at30.dedupeKey);
    // A second, tighter threshold is its own crossing and fires again.
    expect(at14.dedupeKey).not.toBe(at30.dedupeKey);

    const renewed = state({
      expiring: [{ kind: "domain", name: "bald.de", expiresAt: inDays(20) }],
    });
    const after = buildNotificationEvents(renewed, [rule("expiry_soon", 30)])[0]!;
    expect(after.dedupeKey).not.toBe(at30.dedupeKey);
  });

  it("reports an already expired certificate", () => {
    const events = buildNotificationEvents(
      state({
        expiring: [{ kind: "certificate", name: "web.example.test", expiresAt: inDays(-2) }],
      }),
      [rule("expiry_soon", 30)],
    );
    expect(events[0]!.body).toContain("abgelaufen");
  });

  it("falls back to the default threshold when the rule has none", () => {
    const s = state({ expiring: [{ kind: "domain", name: "x.de", expiresAt: inDays(29) }] });
    expect(buildNotificationEvents(s, [rule("expiry_soon")])).toHaveLength(1);
  });
});

describe("worker_down events", () => {
  it("is silent while the heartbeat is fresh", () => {
    expect(buildNotificationEvents(state(), [rule("worker_down")])).toEqual([]);
  });

  it("fires once per calendar day when the heartbeat is stale", () => {
    const stale = state({ workerLastSeenAt: new Date(NOW.getTime() - 3_600_000) });
    const a = buildNotificationEvents(stale, [rule("worker_down")])[0]!;
    const b = buildNotificationEvents(stale, [rule("worker_down")])[0]!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.title).toBe("Worker antwortet nicht");

    const tomorrow = buildNotificationEvents(
      { ...stale, now: new Date(NOW.getTime() + 86_400_000) },
      [rule("worker_down")],
    )[0]!;
    expect(tomorrow.dedupeKey).not.toBe(a.dedupeKey);
  });

  it("handles a worker that never reported", () => {
    const events = buildNotificationEvents(state({ workerLastSeenAt: null }), [
      rule("worker_down"),
    ]);
    expect(events[0]!.body).toContain("kein Lebenszeichen");
  });
});

describe("billing_incomplete events", () => {
  it("is silent for a ready month", () => {
    const s = state({
      billing: {
        period: "2026-09",
        ready: true,
        unassignedCount: 0,
        unassignedCostCents: 0,
        unpricedCount: 0,
      },
    });
    expect(buildNotificationEvents(s, [rule("billing_incomplete")])).toEqual([]);
  });

  it("names what is missing, once per period", () => {
    const s = state({
      billing: {
        period: "2026-09",
        ready: false,
        unassignedCount: 3,
        unassignedCostCents: 1250,
        unpricedCount: 1,
      },
    });
    const events = buildNotificationEvents(s, [rule("billing_incomplete")]);
    expect(events[0]!.title).toBe("Abrechnung unvollständig: September 2026");
    expect(events[0]!.body).toContain("3 Objekt(e) ohne Besitzer");
    expect(events[0]!.body).toContain("12,50");
    expect(events[0]!.body).toContain("1 Kunde(n) ohne Preis");
    expect(
      buildNotificationEvents({ ...s, now: new Date(NOW.getTime() + 86_400_000) }, [
        rule("billing_incomplete"),
      ])[0]!.dedupeKey,
    ).toBe(events[0]!.dedupeKey);
  });
});
