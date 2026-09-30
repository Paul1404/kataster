import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult, CheckStatus, DiscoveredAsset } from "../types";
import { ensureBaseUrl } from "../url";

// Checkmk monitoring server connector. Polls the Checkmk REST API with an
// automation user, discovers monitored hosts, and reports each host's health
// from its host state plus its services. Auth: "Bearer <user> <secret>".

const CheckmkConfig = v.object({
  includeServices: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Services einbeziehen"),
      v.description("Service-Zustände des Hosts (WARN/CRIT) in seinen Status einrechnen"),
    ),
    true,
  ),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000), v.title("Timeout (ms)")),
    15_000,
  ),
});

const CheckmkSecret = v.object({
  serverUrl: v.pipe(
    v.string(),
    v.url(),
    v.title("Server-URL"),
    v.description("Basis-URL des Checkmk-Servers, z. B. https://ops.example.test"),
  ),
  site: v.pipe(v.string(), v.minLength(1), v.title("Site"), v.description("Name der Checkmk-Site")),
  username: v.pipe(v.string(), v.minLength(1), v.title("Automation-Benutzer")),
  automationSecret: v.pipe(v.string(), v.minLength(1), v.title("Automation-Secret")),
});

type Config = v.InferOutput<typeof CheckmkConfig>;
type Secrets = v.InferOutput<typeof CheckmkSecret>;

const num = (val: unknown) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : -1;
};

// Build the REST API base, tolerant of how the user entered the server URL:
// a bare host, a host with the site path, or a full .../check_mk URL all work.
function apiBase(secrets: Secrets): string {
  const site = secrets.site.trim().replace(/^\/+|\/+$/g, "");
  let base = ensureBaseUrl(secrets.serverUrl);
  base = base.replace(/\/check_mk.*$/i, ""); // drop any /check_mk/... suffix
  base = base.replace(/\/api\/.*$/i, ""); // drop any /api/... suffix
  base = base.replace(new RegExp(`/${site}/?$`, "i"), ""); // drop a trailing /<site>
  return `${base}/${site}/check_mk/api/1.0`;
}

function authHeaders(secrets: Secrets): Record<string, string> {
  return {
    Authorization: `Bearer ${secrets.username} ${secrets.automationSecret}`,
    accept: "application/json",
  };
}

// Checkmk REST collections return { value: [{ extensions: {...requested columns} }] }.
function extensions(json: unknown): Record<string, unknown>[] {
  const value = (json as { value?: unknown })?.value;
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const ext = (row as { extensions?: unknown }).extensions;
    return ext && typeof ext === "object" ? (ext as Record<string, unknown>) : {};
  });
}

async function ckGet(
  base: string,
  path: string,
  secrets: Secrets,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${base}/${path}`, { headers: authHeaders(secrets), signal });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

function hostStatus(state: number): CheckStatus {
  if (state === 1) return "down"; // DOWN
  if (state === 2) return "degraded"; // UNREACHABLE
  return "up"; // 0 UP
}

export const checkmkConnector = defineConnector({
  id: "checkmk",
  name: "Checkmk",
  description:
    "Checkmk-Server abfragen: Hosts erkennen und den Zustand jedes Hosts aus Host- und Service-Status melden.",
  icon: "Activity",
  kind: "probe",
  capabilities: { probe: true, inventory: true },
  configSchema: CheckmkConfig,
  secretSchema: CheckmkSecret,
  setup: {
    intro: "Lege in Checkmk einen Automation-Benutzer an und nutze sein Secret als API-Schlüssel.",
    steps: [
      "In Checkmk zu Setup, Benutzer wechseln und einen Benutzer mit der Methode „Automation secret for machine accounts“ anlegen (oder einen vorhandenen öffnen).",
      "Das Automation-Secret kopieren.",
      "Server-URL (z. B. https://ops.example.test), Site-Name, Benutzername und Secret unten eintragen.",
      "Mit Erkennen die überwachten Hosts laden und die gewünschten hinzufügen.",
    ],
    docsUrl: "https://docs.checkmk.com/latest/en/rest_api.html",
  },

  async discover(_config: Config, secrets: Secrets, ctx): Promise<DiscoveredAsset[]> {
    const base = apiBase(secrets);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]);
    // Try the monitored-host list first (visible to monitoring-only automation
    // users), then fall back to the configured-host list (needs setup rights).
    const paths = [
      "domain-types/host/collections/all?columns=name",
      "domain-types/host_config/collections/all",
    ];

    console.info(`[checkmk] discover base=${base}`);
    let lastStatus = 0;
    let lastTitle = "";
    let lastPath = "";
    let connected = false;
    for (const path of paths) {
      const { ok, status, json } = await ckGet(base, path, secrets, signal);
      if (!ok) {
        lastStatus = status;
        lastTitle = (json as { title?: string } | null)?.title ?? "";
        lastPath = path;
        console.warn(
          `[checkmk] GET ${path} -> ${status} body=${JSON.stringify(json)?.slice(0, 300)}`,
        );
        continue;
      }
      connected = true;
      const value =
        (
          json as {
            value?: { id?: string; title?: string; extensions?: { name?: string } }[];
          }
        )?.value ?? [];
      const hosts = value
        .map((r) => String(r.extensions?.name ?? r.id ?? r.title ?? ""))
        .filter(Boolean);
      console.info(
        `[checkmk] GET ${path} -> 200 rows=${value.length} names=${hosts.length}` +
          (value.length > 0 && hosts.length === 0
            ? ` firstRowKeys=${JSON.stringify(Object.keys(value[0] ?? {}))} sample=${JSON.stringify(value[0])?.slice(0, 300)}`
            : ""),
      );
      if (hosts.length > 0) return hosts.map((name) => ({ name, target: name }));
      // 200 but empty: fall through and try the next endpoint.
    }

    if (lastStatus) {
      const hint =
        lastStatus === 401 || lastStatus === 403
          ? "check the automation user and secret"
          : lastStatus === 404
            ? "check the server URL and site name"
            : "";
      throw new Error(
        `Checkmk API returned ${lastStatus}${lastTitle ? ` (${lastTitle})` : ""} for ${base}/${lastPath}${hint ? ` — ${hint}` : ""}`,
      );
    }
    console.warn("[checkmk] discover found no hosts on any endpoint");
    if (connected) {
      // Authenticated fine, but the API returned zero hosts. In Checkmk a user
      // only sees hosts it is a contact for, so this is almost always a scope issue.
      throw new Error(
        "Connected to Checkmk, but the automation user can see 0 hosts. Give it the 'See all host and service objects' permission (or an Administrator role), or add it to the hosts' contact groups.",
      );
    }
    return [];
  },

  async check(target, config: Config, secrets: Secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const base = apiBase(secrets);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);
    const q = encodeURIComponent(JSON.stringify({ op: "=", left: "name", right: target }));

    let host: { ok: boolean; status: number; json: unknown };
    try {
      host = await ckGet(
        base,
        `domain-types/host/collections/all?columns=name&columns=state&query=${q}`,
        secrets,
        signal,
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return {
        status: "down",
        latencyMs: timedOut ? null : Math.round(performance.now() - start),
        message: timedOut
          ? `Zeitüberschreitung nach ${config.timeoutMs} ms`
          : "Checkmk-API nicht erreichbar",
        raw: { error: name },
      };
    }

    if (host.status === 401 || host.status === 403) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message: "Authentifizierung fehlgeschlagen",
        raw: { httpStatus: host.status },
      };
    }

    const hostRows = extensions(host.json);
    const hostState = hostRows.length > 0 ? num(hostRows[0]!.state) : -1;

    let services: { description: string; state: number; output: string }[] = [];
    if (config.includeServices) {
      const sq = encodeURIComponent(JSON.stringify({ op: "=", left: "host_name", right: target }));
      const svc = await ckGet(
        base,
        `domain-types/service/collections/all?columns=description&columns=state&columns=plugin_output&query=${sq}`,
        secrets,
        signal,
      ).catch(() => null);
      if (svc?.ok) {
        services = extensions(svc.json).map((e) => ({
          description: String(e.description ?? ""),
          state: num(e.state),
          output: String(e.plugin_output ?? ""),
        }));
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    const counts = { ok: 0, warn: 0, crit: 0, unknown: 0, total: services.length };
    for (const s of services) {
      if (s.state === 0) counts.ok++;
      else if (s.state === 1) counts.warn++;
      else if (s.state === 2) counts.crit++;
      else counts.unknown++;
    }

    let status: CheckStatus;
    if (hostState === 1) status = "down";
    else if (counts.crit > 0) status = "down";
    else if (counts.warn > 0 || counts.unknown > 0 || hostState === 2) status = "degraded";
    else if (hostState === -1 && services.length === 0) status = "unknown";
    else status = "up";

    const hostWord = hostState === 0 ? "up" : hostState === 1 ? "down" : "unknown";
    const summary = [
      `host ${hostWord}`,
      counts.crit > 0 ? `${counts.crit} CRIT` : null,
      counts.warn > 0 ? `${counts.warn} WARN` : null,
      counts.unknown > 0 ? `${counts.unknown} UNKNOWN` : null,
      services.length > 0 ? `${counts.ok}/${counts.total} OK` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const stateLabel = (s: number) =>
      s === 0 ? "OK" : s === 1 ? "WARN" : s === 2 ? "CRIT" : "UNKNOWN";

    return {
      status,
      latencyMs,
      message: summary || `Host ${hostWord}`,
      raw: {
        host: { state: hostState, status: hostStatus(hostState) },
        // Human-readable, state-first rows so the detail table reads cleanly.
        services: services.map((s) => ({
          state: stateLabel(s.state),
          description: s.description,
          output: s.output,
        })),
        counts,
      },
    };
  },
});
