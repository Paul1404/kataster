import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult } from "../types";
import { ensureBaseUrl } from "../url";

// Mailcow (dockerized) health + inventory probe via its read-only API.
// Auth: X-API-Key header. Primary health is container state; the check also
// pulls domains, mailboxes, aliases, storage and the mail queue for depth.

const MailcowConfig = v.object({
  timeoutMs: v.optional(
    v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000), v.title("Timeout (ms)")),
    15_000,
  ),
  diskWarnPercent: v.optional(
    v.pipe(
      v.number(),
      v.minValue(1),
      v.maxValue(100),
      v.title("Festplattenwarnung (%)"),
      v.description("Als eingeschränkt markieren, wenn die vmail-Belegung diesen Wert erreicht"),
    ),
    90,
  ),
  queueWarn: v.optional(
    v.pipe(
      v.number(),
      v.minValue(1),
      v.title("Warnung Mailwarteschlange"),
      v.description(
        "Als eingeschränkt markieren, wenn die Postfix-Warteschlange diesen Wert erreicht",
      ),
    ),
    100,
  ),
});

const MailcowSecret = v.object({
  apiKey: v.pipe(v.string(), v.minLength(1), v.title("API-Schlüssel")),
});

type Secrets = v.InferOutput<typeof MailcowSecret>;

const truthy = (val: unknown) => val === 1 || val === "1" || val === true;
const num = (val: unknown) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

async function getJson(base: string, path: string, key: string, signal: AbortSignal): Promise<any> {
  try {
    const res = await fetch(`${base}/api/v1/get/${path}`, {
      headers: { "X-API-Key": key, accept: "application/json" },
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object" && (data as { type?: string }).type === "error") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export const mailcowConnector = defineConnector({
  id: "mailcow",
  name: "Mailcow",
  description:
    "Mailcow-Mailserver prüfen: Container-Zustand sowie Domains, Postfächer, Aliasse, Speicher und Mailwarteschlange.",
  icon: "Mail",
  kind: "probe",
  capabilities: { probe: true, inventory: false },
  configSchema: MailcowConfig,
  secretSchema: MailcowSecret,
  setup: {
    intro: "Erzeuge in der Mailcow-Admin-Oberfläche einen lesenden API-Schlüssel.",
    steps: [
      "Als Administrator in der Mailcow-Admin-Oberfläche anmelden.",
      "Zu Konfiguration, Zugang, API wechseln (bei älteren Versionen Konfiguration, API).",
      "„API aktivieren (nur lesend)“ einschalten und, falls angezeigt, dein Netz eintragen oder „IP-Prüfung überspringen“ setzen, damit Kataster zugreifen kann.",
      "Den erzeugten API-Schlüssel kopieren und unten einfügen.",
      "Als Ziel der Prüfung die Mailcow-Basis-URL setzen, z. B. https://mail.example.com.",
    ],
    docsUrl: "https://docs.mailcow.email/api/api-intro/",
  },

  async check(target, config, secrets: Secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const base = ensureBaseUrl(target);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);
    const key = secrets.apiKey;

    // Primary health: container state (also tells us about auth).
    let containersRes: Response;
    try {
      containersRes = await fetch(`${base}/api/v1/get/status/containers`, {
        headers: { "X-API-Key": key, accept: "application/json" },
        signal,
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const name = error instanceof Error ? error.name : "Error";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return {
        status: "down",
        latencyMs: timedOut ? null : latencyMs,
        message: timedOut
          ? `Zeitüberschreitung nach ${config.timeoutMs} ms`
          : "Mailcow-API nicht erreichbar",
        raw: { error: name },
      };
    }

    if (containersRes.status === 401 || containersRes.status === 403) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message: "Authentifizierung fehlgeschlagen",
        raw: { httpStatus: containersRes.status },
      };
    }
    const containersData: unknown = await containersRes.json().catch(() => null);
    if (
      !containersRes.ok ||
      !containersData ||
      typeof containersData !== "object" ||
      (containersData as { type?: string }).type === "error"
    ) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message: `Unerwartete Antwort (${containersRes.status})`,
        raw: { httpStatus: containersRes.status },
      };
    }

    const containers = Object.values(containersData as Record<string, { state?: string }>);
    const total = containers.length;
    const running = containers.filter((c) => c?.state === "running").length;

    // Enrichment endpoints, best-effort and in parallel.
    const [version, domainsRaw, mailboxesRaw, aliasesRaw, vmail, mailq] = await Promise.all([
      getJson(base, "status/version", key, signal),
      getJson(base, "domain/all", key, signal),
      getJson(base, "mailbox/all", key, signal),
      getJson(base, "alias/all", key, signal),
      getJson(base, "status/vmail", key, signal),
      getJson(base, "mailq/all", key, signal),
    ]);
    const latencyMs = Math.round(performance.now() - start);

    const domainList = Array.isArray(domainsRaw) ? domainsRaw : [];
    const domains = domainList.map((d) => ({
      name: String(d.domain_name ?? ""),
      active: truthy(d.active_int ?? d.active),
      mailboxes: num(d.mboxes_in_domain),
      maxMailboxes: num(d.max_num_mboxes_for_domain),
      aliases: num(d.aliases_in_domain),
      storageBytes: num(d.bytes_total),
      messages: num(d.msgs_total),
    }));

    const mailboxList = Array.isArray(mailboxesRaw) ? mailboxesRaw : [];
    const mailboxes = {
      count: mailboxList.length,
      active: mailboxList.filter((m) => truthy(m.active_int ?? m.active)).length,
      quotaUsedBytes: mailboxList.reduce((s, m) => s + num(m.quota_used), 0),
      messages: mailboxList.reduce((s, m) => s + num(m.messages), 0),
      // Per-mailbox rows for the inventory sync (stripped from stored history).
      list: mailboxList.map((m) => ({
        address: String(m.username ?? ""),
        domain: String(m.domain ?? ""),
        name: m.name ? String(m.name) : null,
        active: truthy(m.active_int ?? m.active),
        quotaBytes: num(m.quota),
        quotaUsedBytes: num(m.quota_used),
        messages: num(m.messages),
      })),
    };

    const aliasCount = Array.isArray(aliasesRaw) ? aliasesRaw.length : undefined;
    const mailQueue = Array.isArray(mailq) ? mailq.length : undefined;
    const diskPercent = vmail?.used_percent
      ? Number.parseInt(String(vmail.used_percent), 10)
      : undefined;

    let status: CheckResult["status"] = "up";
    if (running < total) status = "degraded";
    if (diskPercent !== undefined && diskPercent >= config.diskWarnPercent) status = "degraded";
    if (mailQueue !== undefined && mailQueue >= config.queueWarn) status = "degraded";

    const versionStr = version?.version ? String(version.version) : undefined;
    const summary = [
      versionStr ? `v${versionStr}` : null,
      domainsRaw ? `${domains.length} Domains` : null,
      mailboxesRaw ? `${mailboxes.count} Postfächer` : null,
      `${running}/${total} Container`,
      diskPercent !== undefined ? `${diskPercent} % Festplatte` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      status,
      latencyMs,
      message: summary,
      raw: {
        version: versionStr,
        containers: { running, total },
        domains: { count: domains.length, list: domains },
        mailboxes,
        aliases: { count: aliasCount },
        storage: vmail
          ? { used: vmail.used, total: vmail.total, usedPercent: vmail.used_percent }
          : undefined,
        mailQueue: { count: mailQueue },
      },
    };
  },
});
