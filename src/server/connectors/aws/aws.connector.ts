import { ACMClient, ListCertificatesCommand } from "@aws-sdk/client-acm";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { Route53Client } from "@aws-sdk/client-route-53";
import { ListDomainsCommand, Route53DomainsClient } from "@aws-sdk/client-route-53-domains";
import { ListEmailIdentitiesCommand, ListTenantsCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult, DiscoveredAsset } from "../types";
import {
  type ApexFlags,
  analyzeRecordSets,
  checkDelegation,
  checkDnssec,
  countRecords,
  type Finding,
  listAllZones,
  listRecordSets,
  shortZoneId,
  summarizeRecord,
  zoneName,
} from "./route53-analysis";

const AwsConfig = v.object({
  pullDns: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Route-53-Zonen"),
      v.description("DNS-Zonen inventarisieren und ihre Einträge analysieren"),
    ),
    true,
  ),
  pullRegistry: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Registrierte Domains"),
      v.description("Bei Route 53 registrierte Domains, Ablauf und Auto-Verlängerung erfassen"),
    ),
    true,
  ),
  pullWeb: v.optional(
    v.pipe(
      v.boolean(),
      v.title("CloudFront-Distributionen"),
      v.description("CloudFront-Distributionen und Weiterleitungen inventarisieren"),
    ),
    true,
  ),
  pullSes: v.optional(
    v.pipe(
      v.boolean(),
      v.title("SES-E-Mail-Identitäten"),
      v.description("Verifizierte SES-Absenderidentitäten erfassen"),
    ),
    true,
  ),
  pullCerts: v.optional(
    v.pipe(
      v.boolean(),
      v.title("ACM-Zertifikate"),
      v.description("Zertifikate im AWS Certificate Manager samt Ablauf erfassen"),
    ),
    true,
  ),
  pullTenants: v.optional(
    v.pipe(
      v.boolean(),
      v.title("SES-Mandanten"),
      v.description("SES-Mandanten erfassen (Versandtrennung je Kunde)"),
    ),
    true,
  ),
  pullCost: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Cost Explorer (laufender Monat)"),
      v.description(
        "AWS-Ausgaben des Monats einmal täglich in die Marge übernehmen (braucht ce:GetCostAndUsage)",
      ),
    ),
    false,
  ),
  sesRegion: v.optional(
    v.pipe(
      v.string(),
      v.title("SES-Region"),
      v.description("SES ist regional, alles andere global (us-east-1)"),
    ),
    "eu-central-1",
  ),
  analyzeRecords: v.optional(
    v.pipe(
      v.boolean(),
      v.title("DNS-Zustand analysieren"),
      v.description("Einträge auf Delegation, TTL und Mail-/Web-Probleme prüfen"),
    ),
    true,
  ),
  includeRecordCounts: v.optional(
    v.pipe(
      v.boolean(),
      v.title("Einträge je Zone zählen"),
      v.description("Record-Sets je Zone zählen"),
    ),
    true,
  ),
  checkDnssec: v.optional(
    v.pipe(
      v.boolean(),
      v.title("DNSSEC prüfen"),
      v.description("DNSSEC-Signaturstatus je öffentlicher Zone melden"),
    ),
    false,
  ),
  maxRecordsAnalyzed: v.optional(
    v.pipe(
      v.number(),
      v.minValue(25),
      v.maxValue(5000),
      v.title("Max. analysierte Einträge"),
      v.description("Begrenzt die Prüfung je Zone bei sehr großen Zonen"),
    ),
    1000,
  ),
});

const AwsSecret = v.object({
  accessKeyId: v.pipe(v.string(), v.minLength(1), v.title("AWS Access Key ID")),
  secretAccessKey: v.pipe(v.string(), v.minLength(1), v.title("AWS Secret Access Key")),
  region: v.optional(v.pipe(v.string(), v.title("Region")), "us-east-1"),
});

type Secrets = v.InferOutput<typeof AwsSecret>;
type AwsConfigOut = v.InferOutput<typeof AwsConfig>;

const EXPIRY_WARN_DAYS = 30;
const EXPIRY_CRITICAL_DAYS = 7;
const DAY_MS = 86_400_000;

function credentials(secrets: Secrets) {
  return { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey };
}

// TLDs that have no registrar transfer-lock concept; Route 53 reports it off for
// these even though there is nothing to enable.
const NO_TRANSFER_LOCK_TLDS = new Set(["de"]);
function supportsTransferLock(domain: string): boolean {
  return !NO_TRANSFER_LOCK_TLDS.has(domain.split(".").pop() ?? "");
}

function isThrottle(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return (
    name === "Throttling" || name === "ThrottlingException" || name === "PriorRequestNotComplete"
  );
}

interface ZoneOut {
  name: string;
  zoneId: string;
  private: boolean;
  recordCount?: number;
  recordTypes?: Record<string, number>;
  dnssecEnabled?: boolean | null;
  apex?: ApexFlags;
  findings?: Finding[];
  truncated?: boolean;
  error?: boolean;
}

async function collectDns(secrets: Secrets, config: AwsConfigOut, signal: AbortSignal) {
  const client = new Route53Client({ region: secrets.region, credentials: credentials(secrets) });
  const zones = await listAllZones(client, signal);
  let errored = 0;
  const list: ZoneOut[] = await Promise.all(
    zones.map(async (z): Promise<ZoneOut> => {
      const id = shortZoneId(z.Id);
      const name = zoneName(z.Name);
      const base: ZoneOut = { name, zoneId: id, private: z.Config?.PrivateZone ?? false };
      if (!config.includeRecordCounts && !config.analyzeRecords) return base;
      try {
        if (!config.analyzeRecords) {
          return { ...base, recordCount: await countRecords(client, id, signal) };
        }
        const { records: raw, truncated } = await listRecordSets(
          client,
          id,
          signal,
          config.maxRecordsAnalyzed,
        );
        const records = raw.map(summarizeRecord);
        const analysis = analyzeRecordSets(name, records, truncated, config.maxRecordsAnalyzed);
        let dnssecEnabled: boolean | null | undefined;
        if (!base.private) {
          const route53Ns = records
            .filter((r) => r.name === name && r.type === "NS")
            .flatMap((r) => r.values);
          analysis.findings.push(...(await checkDelegation(name, route53Ns)));
          if (config.checkDnssec) {
            const dnssec = await checkDnssec(client, id, name, signal);
            dnssecEnabled = dnssec.signing;
            analysis.findings.push(...dnssec.findings);
          }
        }
        return {
          ...base,
          recordCount: config.includeRecordCounts ? analysis.recordCount : undefined,
          recordTypes: analysis.recordTypes,
          apex: analysis.apex,
          dnssecEnabled,
          findings: analysis.findings,
          truncated: analysis.truncated,
        };
      } catch {
        errored += 1;
        return {
          ...base,
          recordCount: 0,
          error: true,
          findings: [
            {
              severity: "critical",
              code: "record_scan_failed",
              zone: name,
              message: "Record-Sets konnten nicht geprüft werden",
            },
          ],
        };
      }
    }),
  );
  const findings = list.flatMap((z) => z.findings ?? []);
  return { block: { count: list.length, list }, findings, errored };
}

interface RegistryOut {
  name: string;
  registrar: string | null;
  expiresAt: string | null;
  autoRenew: boolean | null;
  transferLock: boolean | null;
}

async function collectRegistry(secrets: Secrets, signal: AbortSignal, now: Date) {
  // Route 53 Domains API is only served from us-east-1.
  const client = new Route53DomainsClient({
    region: "us-east-1",
    credentials: credentials(secrets),
  });
  const list: RegistryOut[] = [];
  const findings: Finding[] = [];
  let nextPageMarker: string | undefined;
  do {
    const out = await client.send(new ListDomainsCommand({ Marker: nextPageMarker }), {
      abortSignal: signal,
    });
    for (const d of out.Domains ?? []) {
      const name = (d.DomainName ?? "").replace(/\.$/, "").toLowerCase();
      if (!name) continue;
      const expiresAt = d.Expiry ? new Date(d.Expiry) : null;
      list.push({
        name,
        registrar: "Amazon Registrar",
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        autoRenew: d.AutoRenew ?? null,
        transferLock: d.TransferLock ?? null,
      });
      if (expiresAt) {
        const days = (expiresAt.getTime() - now.getTime()) / DAY_MS;
        if (days <= EXPIRY_CRITICAL_DAYS) {
          findings.push({
            severity: "critical",
            code: "registry_expiring",
            zone: name,
            message: `Domain läuft in ${Math.max(0, Math.round(days))} Tag(en) ab`,
          });
        } else if (days <= EXPIRY_WARN_DAYS) {
          findings.push({
            severity: "warning",
            code: "registry_expiring",
            zone: name,
            message: `Domain läuft in ${Math.round(days)} Tag(en) ab`,
          });
        }
      }
      if (d.AutoRenew === false) {
        findings.push({
          severity: "warning",
          code: "registry_autorenew_off",
          zone: name,
          message: "Auto-Verlängerung ist aus",
        });
      }
      // Some ccTLDs (e.g. .de / DENIC) have no registrar transfer lock, so Route 53
      // always reports it off -- don't raise a finding for those.
      if (d.TransferLock === false && supportsTransferLock(name)) {
        findings.push({
          severity: "info",
          code: "registry_transferlock_off",
          zone: name,
          message: "Transfersperre ist aus",
        });
      }
    }
    nextPageMarker = out.NextPageMarker;
  } while (nextPageMarker);
  return { block: { count: list.length, list }, findings, errored: 0 };
}

interface WebOut {
  distributionId: string;
  aliases: string[];
  primaryAlias: string | null;
  originDomain: string | null;
  behavior: "serve" | "redirect";
  enabled: boolean;
  status: string | null;
}

function inferRedirect(dist: any): boolean {
  const origins: any[] = dist.Origins?.Items ?? [];
  if (origins.some((o) => String(o.DomainName ?? "").includes("s3-website"))) return true;
  const fns = dist.DefaultCacheBehavior?.FunctionAssociations?.Items ?? [];
  const lambdas = dist.DefaultCacheBehavior?.LambdaFunctionAssociations?.Items ?? [];
  if (fns.length > 0 || lambdas.length > 0) return true;
  return false;
}

async function collectWeb(secrets: Secrets, signal: AbortSignal) {
  // CloudFront is global; its API lives in us-east-1.
  const client = new CloudFrontClient({ region: "us-east-1", credentials: credentials(secrets) });
  const list: WebOut[] = [];
  let marker: string | undefined;
  do {
    const out = await client.send(new ListDistributionsCommand({ Marker: marker }), {
      abortSignal: signal,
    });
    const items: any[] = out.DistributionList?.Items ?? [];
    for (const dist of items) {
      const aliases: string[] = (dist.Aliases?.Items ?? []).map((a: string) =>
        a.replace(/\.$/, "").toLowerCase(),
      );
      const origin = dist.Origins?.Items?.[0]?.DomainName ?? null;
      list.push({
        distributionId: String(dist.Id ?? ""),
        aliases,
        primaryAlias: aliases[0] ?? null,
        originDomain: origin ? String(origin) : null,
        behavior: inferRedirect(dist) ? "redirect" : "serve",
        enabled: Boolean(dist.Enabled),
        status: dist.Status ? String(dist.Status) : null,
      });
    }
    marker = out.DistributionList?.IsTruncated ? out.DistributionList?.NextMarker : undefined;
  } while (marker);
  return { block: { count: list.length, list }, findings: [] as Finding[], errored: 0 };
}

interface SesOut {
  name: string;
  type: string;
  verified: boolean;
  sendingEnabled: boolean;
}

async function collectSes(secrets: Secrets, region: string, signal: AbortSignal) {
  const client = new SESv2Client({ region, credentials: credentials(secrets) });
  const list: SesOut[] = [];
  const findings: Finding[] = [];
  let nextToken: string | undefined;
  do {
    const out = await client.send(new ListEmailIdentitiesCommand({ NextToken: nextToken }), {
      abortSignal: signal,
    });
    for (const id of out.EmailIdentities ?? []) {
      const name = (id.IdentityName ?? "").replace(/\.$/, "").toLowerCase();
      if (!name) continue;
      const verified = id.VerificationStatus === "SUCCESS";
      list.push({
        name,
        type: String(id.IdentityType ?? ""),
        verified,
        sendingEnabled: Boolean(id.SendingEnabled),
      });
      if (id.IdentityType === "DOMAIN" && !verified) {
        findings.push({
          severity: "warning",
          code: "ses_not_verified",
          zone: name,
          message: "SES-Identität ist nicht verifiziert",
        });
      }
    }
    nextToken = out.NextToken;
  } while (nextToken);
  return { block: { region, count: list.length, list }, findings, errored: 0 };
}

interface TenantOut {
  name: string;
  id: string;
  arn: string;
}

async function collectTenants(secrets: Secrets, region: string, signal: AbortSignal) {
  // SES tenants are regional, like identities, so they live in the SES region.
  const client = new SESv2Client({ region, credentials: credentials(secrets) });
  const list: TenantOut[] = [];
  let nextToken: string | undefined;
  do {
    const out = await client.send(new ListTenantsCommand({ NextToken: nextToken }), {
      abortSignal: signal,
    });
    for (const t of out.Tenants ?? []) {
      if (!t.TenantName) continue;
      list.push({
        name: t.TenantName,
        id: String(t.TenantId ?? ""),
        arn: String(t.TenantArn ?? ""),
      });
    }
    nextToken = out.NextToken;
  } while (nextToken);
  return { block: { region, count: list.length, list }, findings: [] as Finding[], errored: 0 };
}

interface CertOut {
  commonName: string;
  sans: string[];
  issuer: string | null;
  notAfter: string | null;
  status: string | null;
}

async function collectCerts(secrets: Secrets, signal: AbortSignal, now: Date) {
  // CloudFront certificates must live in us-east-1, so that is where we look.
  const client = new ACMClient({ region: "us-east-1", credentials: credentials(secrets) });
  const list: CertOut[] = [];
  const findings: Finding[] = [];
  let nextToken: string | undefined;
  do {
    const out = await client.send(new ListCertificatesCommand({ NextToken: nextToken }), {
      abortSignal: signal,
    });
    for (const c of out.CertificateSummaryList ?? []) {
      const commonName = (c.DomainName ?? "").replace(/\.$/, "").toLowerCase();
      if (!commonName) continue;
      const notAfter = c.NotAfter ? new Date(c.NotAfter) : null;
      list.push({
        commonName,
        sans: (c.SubjectAlternativeNameSummaries ?? []).map((s) =>
          s.replace(/\.$/, "").toLowerCase(),
        ),
        issuer: "Amazon",
        notAfter: notAfter ? notAfter.toISOString() : null,
        status: c.Status ? String(c.Status) : null,
      });
      if (notAfter) {
        const days = (notAfter.getTime() - now.getTime()) / DAY_MS;
        if (days <= EXPIRY_CRITICAL_DAYS) {
          findings.push({
            severity: "critical",
            code: "cert_expiring",
            zone: commonName,
            message: `Zertifikat läuft in ${Math.max(0, Math.round(days))} Tag(en) ab`,
          });
        } else if (days <= EXPIRY_WARN_DAYS) {
          findings.push({
            severity: "warning",
            code: "cert_expiring",
            zone: commonName,
            message: `Zertifikat läuft in ${Math.round(days)} Tag(en) ab`,
          });
        }
      }
    }
    nextToken = out.NextToken;
  } while (nextToken);
  return { block: { count: list.length, list }, findings, errored: 0 };
}

// Pure: sum the UnblendedCost across Cost Explorer result periods into cents.
export function parseCeTotal(
  resultsByTime: { Total?: Record<string, { Amount?: string; Unit?: string }> }[] | undefined,
): { amountCents: number; currency: string } {
  let amount = 0;
  let currency = "USD";
  for (const r of resultsByTime ?? []) {
    const cost = r.Total?.UnblendedCost;
    if (!cost?.Amount) continue;
    const n = Number.parseFloat(cost.Amount);
    if (Number.isFinite(n)) amount += n;
    if (cost.Unit) currency = cost.Unit;
  }
  return { amountCents: Math.round(amount * 100), currency };
}

/**
 * Pure: sum UnblendedCost per AWS service across Cost Explorer result periods.
 * Grouping by SERVICE rides along on the same request, so this costs nothing
 * extra -- and Cost Explorer bills per request, so never make a second call just
 * to get the breakdown. Cents, keyed by the service name CE reports.
 */
export function parseCeByService(
  resultsByTime:
    | { Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string }> }[] }[]
    | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of resultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const service = g.Keys?.[0];
      const n = Number.parseFloat(g.Metrics?.UnblendedCost?.Amount ?? "");
      if (!service || !Number.isFinite(n)) continue;
      out[service] = (out[service] ?? 0) + n * 100;
    }
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]!);
  return out;
}

async function collectCost(secrets: Secrets, signal: AbortSignal, now: Date) {
  const client = new CostExplorerClient({ region: "us-east-1", credentials: credentials(secrets) });
  const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const start = `${ym(now)}-01`;
  // Cost Explorer's End is exclusive, so use the first of next month.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: `${ym(next)}-01` },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }),
    { abortSignal: signal },
  );
  const { amountCents: totalCents, currency } = parseCeTotal(out.ResultsByTime);
  const byService = parseCeByService(out.ResultsByTime);
  // With GroupBy set, Cost Explorer leaves ResultsByTime[].Total empty and reports
  // everything under Groups, so the grouped sum is the real total. Keep the
  // ungrouped Total as a fallback in case that ever changes back.
  const groupedCents = Object.values(byService).reduce((a, b) => a + b, 0);
  const amountCents = groupedCents > 0 ? groupedCents : totalCents;
  return {
    block: { amountCents, currency, period: ym(now), byService },
    findings: [] as Finding[],
    errored: 0,
  };
}

function metric(key: string, label: string, value: number, group: string) {
  return { key, label, value, unit: "count", group };
}

export const awsConnector = defineConnector({
  id: "aws",
  name: "AWS",
  description:
    "AWS-Konto inventarisieren und prüfen: Route-53-DNS, registrierte Domains, CloudFront und SES, per lesendem IAM-Zugriffsschlüssel.",
  icon: "Cloud",
  kind: "source",
  capabilities: { probe: true, inventory: true },
  configSchema: AwsConfig,
  secretSchema: AwsSecret,
  defaultIntervalSeconds: 900,
  setup: {
    intro:
      "Lege einen lesenden IAM-Zugriffsschlüssel an und hänge Read-only-Richtlinien für die gewünschten Dienste an. Schreibrechte sind nie nötig.",
    steps: [
      "AWS-Konsole öffnen und zu IAM wechseln (oben nach „IAM“ suchen).",
      "Benutzer, dann Benutzer erstellen. Name z. B. „lfio-readonly“. Keinen Konsolenzugriff aktivieren.",
      "Bei den Berechtigungen „Richtlinien direkt anfügen“ wählen und anhängen: AmazonRoute53ReadOnlyAccess, AmazonRoute53DomainsReadOnlyAccess, CloudFrontReadOnlyAccess, AmazonSESReadOnlyAccess.",
      "Benutzer fertigstellen, öffnen und zum Reiter „Sicherheitsanmeldeinformationen“ wechseln.",
      "Unter „Zugriffsschlüssel“ einen Zugriffsschlüssel erstellen, „Anwendung außerhalb von AWS“ wählen und anlegen.",
      "Access Key ID und Secret Access Key kopieren und unten eintragen. Region auf us-east-1 lassen, die SES-Region auf die Region deiner Absenderidentitäten setzen.",
    ],
    docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },

  async discover(): Promise<DiscoveredAsset[]> {
    // One asset per AWS account. Per-domain granularity lives in the domains table.
    return [{ name: "AWS account", target: "*" }];
  },

  async check(_target, config, secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const findings: Finding[] = [];
    const raw: Record<string, unknown> = { region: secrets.region };
    const serviceErrors: string[] = [];
    let attempted = 0;
    let errored = 0;
    let throttled = false;

    async function run(
      name: string,
      enabled: boolean,
      fn: () => Promise<{ block: unknown; findings: Finding[] }>,
    ) {
      if (!enabled) return;
      attempted += 1;
      try {
        const out = await fn();
        raw[name] = out.block;
        findings.push(...out.findings);
      } catch (error) {
        errored += 1;
        if (isThrottle(error)) throttled = true;
        serviceErrors.push(name);
        const msg = error instanceof Error ? error.message : "Anfrage fehlgeschlagen";
        findings.push({
          severity: "critical",
          code: `${name}_failed`,
          zone: name,
          message: `${name}: ${msg}`,
        });
      }
    }

    await run("zones", config.pullDns, () => collectDns(secrets, config, ctx.signal));
    await run("registry", config.pullRegistry, () => collectRegistry(secrets, ctx.signal, ctx.now));
    await run("web", config.pullWeb, () => collectWeb(secrets, ctx.signal));
    await run("ses", config.pullSes, () => collectSes(secrets, config.sesRegion, ctx.signal));
    await run("tenants", config.pullTenants, () =>
      collectTenants(secrets, config.sesRegion, ctx.signal),
    );
    await run("certs", config.pullCerts, () => collectCerts(secrets, ctx.signal, ctx.now));
    await run("cost", config.pullCost, () => collectCost(secrets, ctx.signal, ctx.now));

    const latencyMs = Math.round(performance.now() - start);
    const criticalFindings = findings.filter(
      (f) => f.severity === "critical" && !serviceErrors.includes(f.zone),
    ).length;
    const warningFindings = findings.filter((f) => f.severity === "warning").length;
    const infoFindings = findings.filter((f) => f.severity === "info").length;

    // Total failure (all enabled services errored, e.g. bad credentials) is down,
    // unless throttled. A partial failure or any finding degrades.
    let status: CheckResult["status"];
    if (attempted > 0 && errored === attempted) status = throttled ? "degraded" : "down";
    else if (errored > 0 || criticalFindings > 0 || warningFindings > 0) status = "degraded";
    else status = "up";

    const zoneCount = (raw.zones as { count?: number } | undefined)?.count ?? 0;
    const domainCount = (raw.registry as { count?: number } | undefined)?.count ?? 0;
    const webCount = (raw.web as { count?: number } | undefined)?.count ?? 0;
    const sesCount = (raw.ses as { count?: number } | undefined)?.count ?? 0;
    const tenantCount = (raw.tenants as { count?: number } | undefined)?.count ?? 0;
    const certCount = (raw.certs as { count?: number } | undefined)?.count ?? 0;

    raw.findings = findings;
    raw.findingCounts = {
      critical: criticalFindings,
      warning: warningFindings,
      info: infoFindings,
    };
    raw.metrics = [
      ...(config.pullDns ? [metric("zones", "Zonen", zoneCount, "DNS")] : []),
      ...(config.pullRegistry
        ? [metric("domains", "Registrierte Domains", domainCount, "Registrar")]
        : []),
      ...(config.pullWeb ? [metric("distributions", "CloudFront", webCount, "Web")] : []),
      ...(config.pullSes ? [metric("sesIdentities", "SES-Identitäten", sesCount, "E-Mail")] : []),
      ...(config.pullTenants ? [metric("sesTenants", "SES-Mandanten", tenantCount, "E-Mail")] : []),
      ...(config.pullCerts ? [metric("certificates", "Zertifikate", certCount, "Web")] : []),
      metric("findings", "Befunde", findings.length, "Zustand"),
    ];

    const parts: string[] = [];
    if (config.pullDns) parts.push(`${zoneCount} Zonen`);
    if (config.pullRegistry) parts.push(`${domainCount} Domains`);
    if (config.pullWeb) parts.push(`${webCount} CDN`);
    if (config.pullSes) parts.push(`${sesCount} SES`);
    if (config.pullTenants) parts.push(`${tenantCount} Mandanten`);
    if (config.pullCerts) parts.push(`${certCount} Zertifikate`);
    const findingSummary =
      findings.length > 0
        ? ` · ${findings.length} ${findings.length === 1 ? "Befund" : "Befunde"}`
        : "";
    const message = `${parts.join(" · ")}${findingSummary}`;

    return { status, latencyMs, message, raw };
  },
});
