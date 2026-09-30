import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult } from "../types";
import { ensureBaseUrl } from "../url";

// WordPress health probe via the public REST API root (/wp-json). A healthy site
// returns 200 with a JSON body containing the site "name". No credentials needed.

const WordpressConfig = v.object({
  apiPath: v.optional(v.pipe(v.string(), v.title("REST-API-Pfad")), "/wp-json"),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.minValue(1000), v.maxValue(60_000), v.title("Timeout (ms)")),
    10_000,
  ),
  degradedAboveMs: v.optional(
    v.pipe(
      v.number(),
      v.title("Eingeschränkt ab (ms)"),
      v.description("Antwortzeiten darüber gelten als eingeschränkt, nicht als Ausfall"),
    ),
    2_500,
  ),
});

function joinUrl(target: string, path: string): string {
  return `${ensureBaseUrl(target)}/${path.replace(/^\/+/, "")}`;
}

export const wordpressConnector = defineConnector({
  id: "wordpress",
  name: "WordPress",
  description:
    "WordPress-Website über ihre REST-API prüfen. Meldet Erreichbarkeit und Antwortzeit.",
  icon: "Newspaper",
  kind: "probe",
  capabilities: { probe: true, inventory: false },
  configSchema: WordpressConfig,

  async check(target, config, _secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);
    try {
      const res = await fetch(joinUrl(target, config.apiPath), {
        headers: { accept: "application/json", "user-agent": "kataster-probe/1.0" },
        signal,
      });
      const latencyMs = Math.round(performance.now() - start);
      const data: unknown = await res.json().catch(() => null);
      const name = data && typeof data === "object" ? (data as { name?: unknown }).name : undefined;

      if (!res.ok || typeof name !== "string") {
        return {
          status: "down",
          latencyMs,
          message: `REST-API nicht erreichbar (${res.status})`,
          raw: { httpStatus: res.status },
        };
      }

      const namespaces = Array.isArray((data as { namespaces?: unknown }).namespaces)
        ? (data as { namespaces: unknown[] }).namespaces.length
        : undefined;
      const status = latencyMs > config.degradedAboveMs ? "degraded" : "up";
      return {
        status,
        latencyMs,
        message: `${name} in ${latencyMs} ms`,
        raw: { siteName: name, namespaces, httpStatus: res.status },
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const errName = error instanceof Error ? error.name : "Error";
      const timedOut = errName === "TimeoutError" || errName === "AbortError";
      return {
        status: "down",
        latencyMs: timedOut ? null : latencyMs,
        message: timedOut
          ? `timed out after ${config.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "request failed",
        raw: { error: errName },
      };
    }
  },
});
