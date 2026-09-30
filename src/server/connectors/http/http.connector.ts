import { connect as tlsConnect } from "node:tls";
import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult, CheckStatus } from "../types";

export interface ObservedCertificate {
  commonName: string;
  sans: string[];
  issuer: string | null;
  notAfter: string | null;
}

// Open a TLS handshake just to read the served certificate. fetch() never exposes
// it, so this is a second short-lived connection. Failures are swallowed (return
// null) so a TLS hiccup never masks the HTTP result.
function readCertificate(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ObservedCertificate | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: ObservedCertificate | null) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const socket = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || Object.keys(cert).length === 0) return finish(null);
        const sans = (cert.subjectaltname ?? "")
          .split(",")
          .map((s: string) => s.trim().replace(/^DNS:/i, ""))
          .filter(Boolean);
        const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? null;
        const notAfter = cert.valid_to ? new Date(cert.valid_to) : null;
        finish({
          commonName: cert.subject?.CN ?? host,
          sans,
          issuer,
          notAfter: notAfter && !Number.isNaN(notAfter.getTime()) ? notAfter.toISOString() : null,
        });
      },
    );
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
  });
}

const CERT_DEGRADE_DAYS = 14;

const HttpConfig = v.object({
  method: v.optional(v.pipe(v.picklist(["GET", "HEAD"]), v.title("Methode")), "GET"),
  checkCertificate: v.optional(
    v.pipe(
      v.boolean(),
      v.title("TLS-Zertifikat prüfen"),
      v.description("Bei https-Zielen den Zertifikatsablauf melden"),
    ),
    true,
  ),
  expectedStatus: v.optional(
    v.pipe(v.number(), v.minValue(100), v.maxValue(599), v.title("Erwarteter Statuscode")),
    200,
  ),
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
    2_000,
  ),
  followRedirects: v.optional(v.pipe(v.boolean(), v.title("Weiterleitungen folgen")), true),
});

export const httpConnector = defineConnector({
  id: "http",
  name: "HTTP / Website",
  description:
    "Einfache Erreichbarkeits- und TLS-Ablaufprüfung für eine einzelne URL. Inventar und Kosten liegen auf Ressourcen, daher zuerst einen Anbieter-Connector nutzen.",
  icon: "Globe",
  kind: "probe",
  capabilities: { probe: true, inventory: false },
  configSchema: HttpConfig,

  async check(target, config, _secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);

    try {
      const res = await fetch(target, {
        method: config.method,
        redirect: config.followRedirects ? "follow" : "manual",
        signal,
        headers: { "user-agent": "kataster-probe/1.0" },
      });
      const latencyMs = Math.round(performance.now() - start);
      const matched = res.status === config.expectedStatus;
      let status: CheckStatus = !matched
        ? "down"
        : latencyMs > config.degradedAboveMs
          ? "degraded"
          : "up";

      const raw: Record<string, unknown> = {
        httpStatus: res.status,
        statusText: res.statusText,
        url: res.url,
      };
      let certNote = "";

      // For https, read the served cert and flag imminent expiry as degraded.
      let url: URL | undefined;
      try {
        url = new URL(target);
      } catch {
        url = undefined;
      }
      if (config.checkCertificate && url?.protocol === "https:") {
        const port = url.port ? Number(url.port) : 443;
        const cert = await readCertificate(url.hostname, port, config.timeoutMs);
        if (cert) {
          raw.certificate = cert;
          if (cert.notAfter) {
            const days = Math.round(
              (new Date(cert.notAfter).getTime() - ctx.now.getTime()) / 86_400_000,
            );
            if (days <= 0) {
              status = "down";
              certNote = " · Zertifikat abgelaufen";
            } else if (days <= CERT_DEGRADE_DAYS) {
              if (status === "up") status = "degraded";
              certNote = ` · Zertifikat läuft in ${days} d ab`;
            }
          }
        }
      }

      return {
        status,
        latencyMs,
        message: matched
          ? `${res.status} in ${latencyMs} ms${certNote}`
          : `erwartet ${config.expectedStatus}, erhalten ${res.status}`,
        raw,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - start);
      const name = error instanceof Error ? error.name : "Error";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return {
        status: "down",
        latencyMs: timedOut ? null : latencyMs,
        message: timedOut
          ? `Zeitüberschreitung nach ${config.timeoutMs} ms`
          : error instanceof Error
            ? error.message
            : "request failed",
        raw: { error: name },
      };
    }
  },
});
