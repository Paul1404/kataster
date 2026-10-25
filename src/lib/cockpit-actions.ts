// Turns the cockpit's raw attention counters into one prioritised worklist.
// Pure on purpose: the dashboard only renders what comes out of here, and the
// ordering rules are covered by tests instead of by reading JSX.

import { formatEuro } from "./format";

export type ActionSeverity = "critical" | "warning" | "info";

/** Where a row sends the operator. Only routes that actually fix the problem. */
export interface ActionLink {
  to: "/objects" | "/billing" | "/costs" | "/ci" | "/sources";
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
  incompleteSourceCount: number;
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

  if (a.incompleteSourceCount > 0) {
    items.push({
      id: "source-data",
      severity: "warning",
      title: `${plural(a.incompleteSourceCount, "Datenquelle unvollständig", "Datenquellen unvollständig")}`,
      detail: "Kosten oder Inventar sind noch nicht vollständig abgeglichen.",
      link: { to: "/sources" },
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
