import type { CheckStatus } from "@/server/connectors/types";

// Pure helpers for the Prüfungen list. Tested in checks-list.test.ts.

const SEVERITY: Record<CheckStatus, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };

/** Problems first (Ausfall, Eingeschränkt, Unbekannt, Online), then by name. */
export function sortChecks<T extends { lastStatus: CheckStatus; name: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => SEVERITY[a.lastStatus] - SEVERITY[b.lastStatus] || a.name.localeCompare(b.name, "de"),
  );
}

function targetHost(target: string): string {
  return target
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * The second line under a check's name: the connector, plus the target when the
 * name does not already say it. Two checks of one host by different connectors
 * ("mail.example.test" by Checkmk and by Mailcow) stay distinguishable, and a
 * source's placeholder target ("*", "railway") is never shown.
 */
export function checkSubtitle(input: {
  name: string;
  target: string;
  connectorName: string;
  kind: "probe" | "source";
}): string {
  if (input.kind === "source") return input.connectorName;
  const host = targetHost(input.target);
  if (!host || input.name.toLowerCase().includes(host)) return input.connectorName;
  return `${input.connectorName} · ${input.target}`;
}
