/**
 * Pure notification engine: current state plus enabled rules in, the events that
 * should be sent out. No database, no fetch, no clock of its own (the caller
 * passes `now`), so the whole alerting policy is unit-testable.
 *
 * Dedupe keys are stable identities, not hashes of the text: the delivery table
 * has a unique index on them, so an event whose key was already recorded can
 * never be sent a second time. Every key is prefixed with the channel id so two
 * channels each get their own copy of the same event.
 */
import { formatDate, formatEuro, formatPeriod } from "../../lib/format";

export type NotificationRuleKind =
  | "incident_opened"
  | "incident_resolved"
  | "expiry_soon"
  | "worker_down"
  | "billing_incomplete";

export interface NotificationRuleInput {
  channelId: string;
  kind: NotificationRuleKind;
  /** Only meaningful for expiry_soon. Falls back to DEFAULT_EXPIRY_THRESHOLD_DAYS. */
  thresholdDays: number | null;
}

export interface IncidentEventInput {
  incidentId: string;
  assetName: string;
  status: "down" | "degraded";
  startedAt: Date;
  endedAt?: Date | null;
  /** Latest check message, the human reason for the outage. */
  message: string | null;
}

export interface ExpiringItemInput {
  kind: "domain" | "certificate";
  name: string;
  expiresAt: Date;
}

export interface BillingStateInput {
  period: string;
  ready: boolean;
  unassignedCount: number;
  unassignedCostCents: number;
  unpricedCount: number;
}

export interface NotificationState {
  now: Date;
  openIncidents: IncidentEventInput[];
  resolvedIncidents: IncidentEventInput[];
  expiring: ExpiringItemInput[];
  /** Null when the worker has never written a heartbeat. */
  workerLastSeenAt: Date | null;
  /** A worker not seen for longer than this counts as down. */
  workerDeadAfterMs: number;
  billing: BillingStateInput | null;
}

export interface NotificationEvent {
  channelId: string;
  ruleKind: NotificationRuleKind;
  dedupeKey: string;
  title: string;
  body: string;
}

export const DEFAULT_EXPIRY_THRESHOLD_DAYS = 30;
/** A worker silent for longer than this is treated as dead by the daily digest. */
export const WORKER_DEAD_AFTER_MS = 10 * 60_000;

const DAY_MS = 86_400_000;

const STATUS_LABEL: Record<"down" | "degraded", string> = {
  down: "Ausfall",
  degraded: "Beeinträchtigt",
};

const KIND_LABEL: Record<"domain" | "certificate", string> = {
  domain: "Domain",
  certificate: "Zertifikat",
};

/** German duration for alert bodies, e.g. "3 h 12 min". Whole units only. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return "unter 1 min";
}

/** UTC calendar day, used to make once-per-day digest keys. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function daysUntil(now: Date, at: Date): number {
  return Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Build every event the given rules ask for.
 * Callers pass only enabled rules of enabled channels.
 */
export function buildNotificationEvents(
  state: NotificationState,
  rules: NotificationRuleInput[],
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  for (const rule of rules) {
    switch (rule.kind) {
      case "incident_opened":
        events.push(...incidentOpenedEvents(state, rule));
        break;
      case "incident_resolved":
        events.push(...incidentResolvedEvents(state, rule));
        break;
      case "expiry_soon":
        events.push(...expiryEvents(state, rule));
        break;
      case "worker_down":
        events.push(...workerDownEvents(state, rule));
        break;
      case "billing_incomplete":
        events.push(...billingEvents(state, rule));
        break;
    }
  }
  return events;
}

function incidentOpenedEvents(
  state: NotificationState,
  rule: NotificationRuleInput,
): NotificationEvent[] {
  return state.openIncidents.map((incident) => {
    const since = formatDuration(state.now.getTime() - incident.startedAt.getTime());
    const reason = incident.message?.trim();
    return {
      channelId: rule.channelId,
      ruleKind: "incident_opened" as const,
      // One key per incident: an escalation or a second digest cannot re-fire it.
      dedupeKey: `${rule.channelId}:incident_opened:${incident.incidentId}`,
      title: `${STATUS_LABEL[incident.status]}: ${incident.assetName}`,
      body: [
        `${incident.assetName} ist seit ${since} ${incident.status === "down" ? "nicht erreichbar" : "beeinträchtigt"}.`,
        reason ? `Meldung: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
}

function incidentResolvedEvents(
  state: NotificationState,
  rule: NotificationRuleInput,
): NotificationEvent[] {
  return state.resolvedIncidents.map((incident) => {
    const ended = incident.endedAt ?? state.now;
    const lasted = formatDuration(ended.getTime() - incident.startedAt.getTime());
    return {
      channelId: rule.channelId,
      ruleKind: "incident_resolved" as const,
      dedupeKey: `${rule.channelId}:incident_resolved:${incident.incidentId}`,
      title: `Wieder erreichbar: ${incident.assetName}`,
      body: `${incident.assetName} läuft wieder. Die Störung dauerte ${lasted}.`,
    };
  });
}

function expiryEvents(state: NotificationState, rule: NotificationRuleInput): NotificationEvent[] {
  const threshold = rule.thresholdDays ?? DEFAULT_EXPIRY_THRESHOLD_DAYS;
  const events: NotificationEvent[] = [];
  for (const item of state.expiring) {
    const left = daysUntil(state.now, item.expiresAt);
    if (left > threshold) continue;
    const label = KIND_LABEL[item.kind];
    // The expiry date is part of the key, so a renewal that moves the date
    // arms the same threshold again instead of staying silent forever.
    const stamp = item.expiresAt.toISOString().slice(0, 10);
    events.push({
      channelId: rule.channelId,
      ruleKind: "expiry_soon",
      dedupeKey: `${rule.channelId}:expiry_soon:${item.kind}:${item.name}:${stamp}:${threshold}`,
      title: `Läuft ab: ${item.name}`,
      body:
        left < 0
          ? `${label} ${item.name} ist seit dem ${formatDate(item.expiresAt)} abgelaufen.`
          : `${label} ${item.name} läuft am ${formatDate(item.expiresAt)} ab, in ${left} Tag${left === 1 ? "" : "en"}.`,
    });
  }
  return events;
}

function workerDownEvents(
  state: NotificationState,
  rule: NotificationRuleInput,
): NotificationEvent[] {
  const age = state.workerLastSeenAt
    ? state.now.getTime() - state.workerLastSeenAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (age <= state.workerDeadAfterMs) return [];
  const seen = state.workerLastSeenAt
    ? `Letztes Lebenszeichen vor ${formatDuration(age)}.`
    : "Es gibt noch kein Lebenszeichen.";
  return [
    {
      channelId: rule.channelId,
      ruleKind: "worker_down",
      // Once per calendar day: a dead worker should nag, but not every digest run.
      dedupeKey: `${rule.channelId}:worker_down:${dayKey(state.now)}`,
      title: "Worker antwortet nicht",
      body: `Der Prüf-Worker meldet sich nicht mehr. ${seen} Solange laufen keine Checks und kein Status ist verlässlich.`,
    },
  ];
}

function billingEvents(state: NotificationState, rule: NotificationRuleInput): NotificationEvent[] {
  const billing = state.billing;
  if (!billing || billing.ready) return [];
  const parts: string[] = [];
  if (billing.unassignedCount > 0) {
    parts.push(
      `${billing.unassignedCount} Objekt(e) ohne Besitzer (${formatEuro(billing.unassignedCostCents)} Kosten)`,
    );
  }
  if (billing.unpricedCount > 0) parts.push(`${billing.unpricedCount} Kunde(n) ohne Preis`);
  return [
    {
      channelId: rule.channelId,
      ruleKind: "billing_incomplete",
      // Once per billing period: the digest reminds about a month exactly once.
      dedupeKey: `${rule.channelId}:billing_incomplete:${billing.period}`,
      title: `Abrechnung unvollständig: ${formatPeriod(billing.period)}`,
      body: `Der Abrechnungsmonat ${formatPeriod(billing.period)} ist noch nicht vollständig. ${
        parts.length > 0 ? `${parts.join(", ")}.` : "Bitte auf der Abrechnungsseite prüfen."
      }`,
    },
  ];
}
