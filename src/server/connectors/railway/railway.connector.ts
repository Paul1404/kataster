import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult } from "../types";

// Railway inventory probe via the public GraphQL API. Lists the account's
// projects and their services; each becomes a resource. Per-project cost is
// layered on in the cost phase.

const RailwayConfig = v.object({
  timeoutMs: v.optional(
    v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000), v.title("Timeout (ms)")),
    15_000,
  ),
  pullCost: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Geschätzte Kosten (je Projekt)"),
      v.description("Geschätzte Railway-Ausgaben je Projekt in die Marge übernehmen"),
    ),
    false,
  ),
});

const RailwaySecret = v.object({
  token: v.pipe(v.string(), v.minLength(1), v.title("Railway-API-Token")),
});

type Secrets = v.InferOutput<typeof RailwaySecret>;

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const QUERY = `query {
  projects {
    edges { node { id name services { edges { node { id name } } } } }
  }
}`;

export interface RailwayService {
  id: string;
  name: string;
}
export interface RailwayProject {
  id: string;
  name: string;
  services: RailwayService[];
}

// Pure: pull projects + services out of a Railway GraphQL response, tolerating
// missing/edge-wrapped shapes.
export function parseRailwayProjects(data: unknown): RailwayProject[] {
  const edges = (data as any)?.data?.projects?.edges;
  if (!Array.isArray(edges)) return [];
  const projects: RailwayProject[] = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node?.id) continue;
    const serviceEdges = node.services?.edges;
    const services: RailwayService[] = Array.isArray(serviceEdges)
      ? serviceEdges
          .map((s: any) => s?.node)
          .filter((n: any) => n?.id)
          .map((n: any) => ({ id: String(n.id), name: String(n.name ?? n.id) }))
      : [];
    projects.push({ id: String(node.id), name: String(node.name ?? node.id), services });
  }
  return projects;
}

// Railway's published metered rates (USD). estimatedUsage returns projected
// end-of-cycle usage in the measurement's base unit: GB-minutes for memory/disk,
// vCPU-minutes for CPU, GB for egress. Multiplying by the per-minute (or per-GB)
// rate yields the estimated dollar cost. Rates from Railway's pricing page; keep
// them here so a price change is a one-line edit.
// https://docs.railway.com/reference/pricing/plans
const RATE_USD: Record<string, number> = {
  MEMORY_USAGE_GB: 0.000231, // $/GB-minute
  CPU_USAGE: 0.000463, // $/vCPU-minute
  DISK_USAGE_GB: 0.000003472222222, // $/GB-minute (volume storage)
  NETWORK_TX_GB: 0.05, // $/GB egress
};
// Ephemeral disk is free; backups have no published per-GB rate, so both are left
// out rather than priced on a guess. Egress (RX) is free, so only TX is billed.
const COST_MEASUREMENTS = Object.keys(RATE_USD);

export interface RailwayUsageRow {
  projectId: string;
  measurement: string;
  estimatedValue: number;
}
export interface RailwayProjectCost {
  projectId: string;
  amountCents: number;
}

// Pure: price raw estimatedUsage rows into per-project cost in cents, summing each
// project's measurements at the published rate. Unknown measurements are ignored.
export function priceRailwayUsage(rows: RailwayUsageRow[]): RailwayProjectCost[] {
  const dollars = new Map<string, number>();
  for (const r of rows) {
    const rate = RATE_USD[r.measurement];
    if (!rate || !Number.isFinite(r.estimatedValue)) continue;
    dollars.set(r.projectId, (dollars.get(r.projectId) ?? 0) + r.estimatedValue * rate);
  }
  return [...dollars].map(([projectId, usd]) => ({
    projectId,
    amountCents: Math.round(usd * 100),
  }));
}

// Fetch estimated usage per project, all measurements in one call. Railway caps
// concurrent usage sub-queries per client (~16); one estimatedUsage request fans
// out to one sub-query per (measurement x project), so scoping each call to a
// single project keeps it at `measurements` sub-queries (4) regardless of how many
// projects exist. Calls run sequentially, so concurrency never climbs.
async function collectRailwayCost(
  token: string,
  projectIds: string[],
  signal: AbortSignal,
): Promise<RailwayUsageRow[]> {
  const rows: RailwayUsageRow[] = [];
  const query = `query($m:[MetricMeasurement!]!,$p:String){ estimatedUsage(measurements:$m,projectId:$p){ estimatedValue measurement projectId } }`;
  for (const projectId of projectIds) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { m: COST_MEASUREMENTS, p: projectId } }),
      signal,
    });
    const json: any = await res.json().catch(() => null);
    if (json?.errors) throw new Error(json.errors[0]?.message ?? "estimatedUsage fehlgeschlagen");
    for (const u of json?.data?.estimatedUsage ?? []) {
      // projectId filtering is server-side; fall back to the queried id if absent.
      rows.push({
        projectId: String(u?.projectId ?? projectId),
        measurement: String(u?.measurement),
        estimatedValue: Number(u?.estimatedValue ?? 0),
      });
    }
  }
  return rows;
}

export const railwayConnector = defineConnector({
  id: "railway",
  name: "Railway",
  description:
    "Railway-Konto inventarisieren: Projekte und ihre Services. Jedes wird eine Ressource für Kundenzuordnung und Kosten.",
  icon: "Train",
  kind: "source",
  capabilities: { probe: true, inventory: true },
  configSchema: RailwayConfig,
  secretSchema: RailwaySecret,
  // One account == one asset; the connector ignores the target.
  autoAssetTarget: () => "railway",
  defaultIntervalSeconds: 900,
  setup: {
    intro: "Lege einen Railway-Kontotoken an, damit Kataster deine Projekte lesen kann.",
    steps: [
      "Railway öffnen, Account Settings, Tokens.",
      "Einen Token anlegen (ohne Team-Scope werden deine persönlichen Projekte gelistet).",
      "Token unten einfügen. Die Prüfung wird beim Speichern automatisch angelegt.",
    ],
    docsUrl: "https://docs.railway.com/reference/public-api",
  },

  async check(_target, config, secrets: Secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secrets.token}`,
        },
        body: JSON.stringify({ query: QUERY }),
        signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return {
        status: "down",
        latencyMs: timedOut ? null : Math.round(performance.now() - start),
        message: timedOut
          ? `Zeitüberschreitung nach ${config.timeoutMs} ms`
          : "Railway-API nicht erreichbar",
        raw: { error: name },
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message: "Authentifizierung fehlgeschlagen",
        raw: { httpStatus: res.status },
      };
    }

    const json: unknown = await res.json().catch(() => null);
    const latencyMs = Math.round(performance.now() - start);
    if (!res.ok || (json as any)?.errors) {
      return {
        status: "down",
        latencyMs,
        message: `Unerwartete Antwort (${res.status})`,
        raw: { httpStatus: res.status, errors: (json as any)?.errors ?? null },
      };
    }

    const projects = parseRailwayProjects(json);
    const serviceCount = projects.reduce((s, p) => s + p.services.length, 0);

    // Optional: estimated per-project spend for the current billing cycle. A cost
    // failure (rate limit, permissions) must not fail the inventory check, so it's
    // best-effort and just omits the cost block.
    let cost: Record<string, unknown> | undefined;
    if (config.pullCost && projects.length > 0) {
      try {
        const usage = await collectRailwayCost(
          secrets.token,
          projects.map((p) => p.id),
          signal,
        );
        const ym = `${ctx.now.getUTCFullYear()}-${String(ctx.now.getUTCMonth() + 1).padStart(2, "0")}`;
        cost = { period: ym, currency: "USD", projects: priceRailwayUsage(usage) };
      } catch (error) {
        cost = { error: error instanceof Error ? error.message : "cost fetch failed" };
      }
    }

    return {
      status: "up",
      latencyMs,
      message: `${projects.length} Projekte · ${serviceCount} Services`,
      raw: {
        ...(cost ? { cost } : {}),
        projects: { count: projects.length, list: projects },
        metrics: [
          {
            key: "projects",
            label: "Projekte",
            value: projects.length,
            unit: "count",
            group: "Railway",
          },
          {
            key: "services",
            label: "Services",
            value: serviceCount,
            unit: "count",
            group: "Railway",
          },
        ],
      },
    };
  },
});
