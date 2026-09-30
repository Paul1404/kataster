import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult } from "../types";

// Hetzner Cloud API connector. Reads the account's servers (hardware, IPs, status,
// and monthly price) and lands each as a facet on the matching Host CI, plus a
// per-host cost pool. Reconciliation to the CI is by public IP (matching the IP
// SSM already contributed), so the same box discovered by SSH/SSM/Cloud collapses
// to one host.

const HetznerCloudConfig = v.object({
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(5000), v.title("Timeout (ms)")), 30_000),
});

const HetznerCloudSecret = v.object({
  apiToken: v.pipe(v.string(), v.minLength(1), v.title("Hetzner-Cloud-API-Token")),
});

type Config = v.InferOutput<typeof HetznerCloudConfig>;
type Secrets = v.InferOutput<typeof HetznerCloudSecret>;

export interface HetznerCloudServer {
  id: number;
  name: string;
  status: string;
  ipv4: string | null;
  serverType: string | null;
  cores: number | null;
  memoryGb: number | null;
  diskGb: number | null;
  location: string | null;
  monthlyPriceCents: number | null;
}

// Loose shapes for the parts of the Hetzner Cloud /servers payload we read.
interface RawPrice {
  location?: string;
  price_monthly?: { gross?: string; net?: string };
}
interface RawServer {
  id?: number;
  name?: string;
  status?: string;
  public_net?: { ipv4?: { ip?: string } | null };
  server_type?: {
    name?: string;
    cores?: number;
    memory?: number;
    disk?: number;
    prices?: RawPrice[];
  };
  datacenter?: { location?: { name?: string } };
}

/** Pure: fold the /servers payload into normalized server rows with monthly price
 * (in cents, from the price entry matching the server's datacenter location). */
export function parseHetznerCloudServers(servers: RawServer[]): HetznerCloudServer[] {
  return servers.map((s) => {
    const location = s.datacenter?.location?.name ?? null;
    const prices = s.server_type?.prices ?? [];
    const priceEntry = prices.find((p) => p.location === location) ?? prices[0];
    const monthly = priceEntry?.price_monthly?.gross ?? priceEntry?.price_monthly?.net;
    const cents =
      monthly != null && Number.isFinite(Number.parseFloat(monthly))
        ? Math.round(Number.parseFloat(monthly) * 100)
        : null;
    return {
      id: s.id ?? 0,
      name: s.name ?? "",
      status: s.status ?? "",
      ipv4: s.public_net?.ipv4?.ip ?? null,
      serverType: s.server_type?.name ?? null,
      cores: s.server_type?.cores ?? null,
      memoryGb: s.server_type?.memory ?? null,
      diskGb: s.server_type?.disk ?? null,
      location,
      monthlyPriceCents: cents,
    };
  });
}

const API = "https://api.hetzner.cloud/v1/servers";

export const hetznerCloudConnector = defineConnector({
  id: "hetzner-cloud",
  name: "Hetzner Cloud",
  description:
    "Server des Hetzner-Cloud-Kontos per API-Token lesen (Typ, Standort, IPs, Status, Monatspreis). Ergänzt Host-CIs und füllt Kostenpools je Host automatisch.",
  icon: "Cloud",
  kind: "source",
  capabilities: { probe: true, inventory: true },
  configSchema: HetznerCloudConfig,
  secretSchema: HetznerCloudSecret,
  autoAssetTarget: () => "hetzner-cloud",
  defaultIntervalSeconds: 1800,
  setup: {
    intro:
      "Lege in der Hetzner Cloud Console einen lesenden API-Token für das Projekt an, dessen Server du erfassen willst.",
    steps: [
      "Hetzner Cloud Console öffnen und das Projekt wählen.",
      "Zu Sicherheit, dann API-Tokens wechseln und einen API-Token erzeugen.",
      "Leserecht vergeben (lesend reicht), anlegen und den Token kopieren.",
      "Token unten einfügen.",
    ],
    docsUrl: "https://docs.hetzner.cloud/#getting-started",
  },

  async check(_target, config: Config, secrets: Secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);
    const raw: RawServer[] = [];
    try {
      let page = 1;
      for (;;) {
        const res = await fetch(`${API}?per_page=50&page=${page}`, {
          headers: { Authorization: `Bearer ${secrets.apiToken}` },
          signal,
        });
        if (!res.ok) throw new Error(`Hetzner Cloud API ${res.status}`);
        const json = (await res.json()) as {
          servers?: RawServer[];
          meta?: { pagination?: { next_page?: number | null } };
        };
        raw.push(...(json.servers ?? []));
        const next = json.meta?.pagination?.next_page;
        if (!next) break;
        page = next;
      }
    } catch (error) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message: error instanceof Error ? error.message : "Hetzner-Cloud-API fehlgeschlagen",
        raw: {},
      };
    }

    const list = parseHetznerCloudServers(raw);
    const running = list.filter((s) => s.status === "running").length;
    const monthlyCents = list.reduce((s, x) => s + (x.monthlyPriceCents ?? 0), 0);
    const status: CheckResult["status"] = running === list.length ? "up" : "degraded";
    const message = `${list.length} Server, ${(monthlyCents / 100).toFixed(2).replace(".", ",")} € / Monat`;

    return {
      status,
      latencyMs: Math.round(performance.now() - start),
      message,
      raw: {
        servers: { count: list.length, list },
        metrics: [
          { key: "servers", label: "Server", value: list.length, unit: "count", group: "Hetzner" },
          {
            key: "monthly",
            label: "Monatskosten",
            value: Math.round(monthlyCents / 100),
            unit: "EUR",
            group: "Hetzner",
          },
        ],
      },
    };
  },
});
