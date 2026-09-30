// Turns the cockpit's raw attention counters into one prioritised worklist.
// Pure on purpose: the dashboard only renders what comes out of here, and the
// ordering rules are covered by tests instead of by reading JSX.

import { formatEuro } from "./format";

export type ActionSeverity = "critical" | "warning" | "info";

/** Where a row sends the operator. Only routes that actually fix the problem. */
export interface ActionLink {
  to: "/objects" | "/billing" | "/costs" | "/ci" | "/assets";
  search?: { owner?: string; type?: string; sort?: string };
}

export interface ActionItem {
  id: string;
  severity: ActionSeverity;
  title: string;
  detail: string;
  link: ActionLink;
}

/** Everything the cockpit knows about work that is still open. */
export interface CockpitAttention {
  unassignedCount: number;
  unassignedCostCents: number;
  unpricedCount: number;
  uncoveredPoolCount: number;
  uncoveredPoolCents: number;
  expiringDomainCount: number;
  expiringCertCount: number;
  /** Days until the nearest expiry, negative when overdue, null when nothing expires. */
  expiringSoonestDays: number | null;
  openIncidentCount: number;
  staleCheckCount: number;
  workerAlive: boolean;
}

const SEVERITY_RANK: Record<ActionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Build the "Handlungsbedarf" list, most urgent first. Rows are emitted in a
 * fixed source order and then stably sorted by severity, so equally severe
 * rows keep a predictable position.
 */
export function buildActionItems(a: CockpitAttention): ActionItem[] {
  const items: ActionItem[] = [];

  if (!a.workerAlive) {
    items.push({
      id: "worker",
      severity: "critical",
      title: "Worker läuft nicht",
      detail: "Ohne Worker laufen keine Prüfungen und keine Synchronisierung.",
      link: { to: "/assets" },
    });
  }

  if (a.openIncidentCount > 0) {
    items.push({
      id: "incidents",
      severity: "critical",
      title: `${plural(a.openIncidentCount, "offene Störung", "offene Störungen")}`,
      detail: "Prüfungen melden seit einer Weile einen Ausfall.",
      link: { to: "/assets" },
    });
  }

  const expirySeverity: ActionSeverity =
    a.expiringSoonestDays !== null && a.expiringSoonestDays <= 14 ? "critical" : "warning";

  if (a.expiringDomainCount > 0) {
    items.push({
      id: "domains-expiring",
      severity: expirySeverity,
      title: `${plural(a.expiringDomainCount, "Domain läuft", "Domains laufen")} bald ab`,
      detail: expiryDetail(a.expiringSoonestDays),
      link: { to: "/ci" },
    });
  }

  if (a.expiringCertCount > 0) {
    items.push({
      id: "certs-expiring",
      severity: expirySeverity,
      title: `${plural(a.expiringCertCount, "Zertifikat läuft", "Zertifikate laufen")} bald ab`,
      detail: expiryDetail(a.expiringSoonestDays),
      link: { to: "/objects", search: { type: "acm_cert" } },
    });
  }

  if (a.unassignedCount > 0) {
    items.push({
      id: "unassigned",
      severity: "warning",
      title: `${plural(a.unassignedCount, "Objekt ohne Eigentümer", "Objekte ohne Eigentümer")}`,
      detail: `${formatEuro(a.unassignedCostCents)} Kosten laufen in den Eigenaufwand.`,
      link: { to: "/objects", search: { owner: "unassigned", sort: "cost" } },
    });
  }

  if (a.unpricedCount > 0) {
    items.push({
      id: "unpriced",
      severity: "warning",
      title: `${plural(a.unpricedCount, "Kunde ohne Position", "Kunden ohne Positionen")}`,
      detail: "Diese Kunden verursachen Kosten, werden aber nicht berechnet.",
      link: { to: "/billing" },
    });
  }

  if (a.staleCheckCount > 0) {
    items.push({
      id: "stale-checks",
      severity: "warning",
      title: `${plural(a.staleCheckCount, "veraltete Prüfung", "veraltete Prüfungen")}`,
      detail: "Seit mehr als dem doppelten Intervall kein Ergebnis.",
      link: { to: "/assets" },
    });
  }

  if (a.uncoveredPoolCount > 0) {
    items.push({
      id: "uncovered-pools",
      severity: "info",
      title: `${plural(a.uncoveredPoolCount, "Kostentopf ohne Zuordnung", "Kostentöpfe ohne Zuordnung")}`,
      detail: `${formatEuro(a.uncoveredPoolCents)} sind keinem Objekt zugeteilt.`,
      link: { to: "/costs" },
    });
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a1, b1) =>
        SEVERITY_RANK[a1.item.severity] - SEVERITY_RANK[b1.item.severity] || a1.index - b1.index,
    )
    .map((entry) => entry.item);
}

function expiryDetail(days: number | null): string {
  if (days === null) return "Ablaufdatum unbekannt.";
  if (days < 0) return "Die früheste Verlängerung ist überfällig.";
  if (days === 0) return "Die früheste Verlängerung ist heute fällig.";
  return `Die früheste Verlängerung ist in ${days} Tagen fällig.`;
}
