import { resolveNs } from "node:dns/promises";
import {
  GetDNSSECCommand,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53";

export type FindingSeverity = "critical" | "warning" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: string;
  zone: string;
  message: string;
}

export interface RecordSetSummary {
  name: string;
  type: string;
  ttl?: number;
  values: string[];
  aliasTarget?: string;
}

export interface ApexFlags {
  hasA: boolean;
  hasAAAA: boolean;
  hasAlias: boolean;
  hasMX: boolean;
  hasNS: boolean;
  hasSOA: boolean;
}

export interface ZoneAnalysis {
  recordCount: number;
  truncated: boolean;
  recordTypes: Record<string, number>;
  findings: Finding[];
  apex: ApexFlags;
}

export const shortZoneId = (id: string | undefined) => (id ?? "").replace("/hostedzone/", "");
export const zoneName = (name: string | undefined) => (name ?? "").replace(/\.$/, "");

export function stripDot(value: string | undefined): string {
  return (value ?? "").replace(/\.$/, "");
}

function recordName(value: string | undefined): string {
  return stripDot(value).toLowerCase();
}

function recordValues(record: any): string[] {
  if (record.AliasTarget?.DNSName) return [stripDot(String(record.AliasTarget.DNSName))];
  return (record.ResourceRecords ?? []).map((r: { Value?: string }) =>
    stripDot(String(r.Value ?? "")),
  );
}

export function summarizeRecord(record: any): RecordSetSummary {
  return {
    name: recordName(record.Name),
    type: String(record.Type ?? ""),
    ttl: record.TTL,
    values: recordValues(record),
    aliasTarget: record.AliasTarget?.DNSName
      ? stripDot(String(record.AliasTarget.DNSName))
      : undefined,
  };
}

export async function listAllZones(client: Route53Client, signal: AbortSignal) {
  const zones = [];
  let marker: string | undefined;
  do {
    const out = await client.send(new ListHostedZonesCommand({ Marker: marker }), {
      abortSignal: signal,
    });
    zones.push(...(out.HostedZones ?? []));
    marker = out.IsTruncated ? out.NextMarker : undefined;
  } while (marker);
  return zones;
}

export async function listRecordSets(
  client: Route53Client,
  zoneId: string,
  signal: AbortSignal,
  limit = Number.POSITIVE_INFINITY,
) {
  const records = [];
  let startName: string | undefined;
  let startType: string | undefined;
  let startIdentifier: string | undefined;
  do {
    const out = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: startName,
        StartRecordType: startType as never,
        StartRecordIdentifier: startIdentifier,
      }),
      { abortSignal: signal },
    );
    records.push(...(out.ResourceRecordSets ?? []));
    if (records.length >= limit) {
      return { records: records.slice(0, limit), truncated: Boolean(out.IsTruncated) };
    }
    startName = out.IsTruncated ? out.NextRecordName : undefined;
    startType = out.IsTruncated ? out.NextRecordType : undefined;
    startIdentifier = out.IsTruncated ? out.NextRecordIdentifier : undefined;
  } while (startName);
  return { records, truncated: false };
}

export async function countRecords(client: Route53Client, zoneId: string, signal: AbortSignal) {
  let count = 0;
  let startName: string | undefined;
  let startType: string | undefined;
  let startIdentifier: string | undefined;
  do {
    const out = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: startName,
        StartRecordType: startType as never,
        StartRecordIdentifier: startIdentifier,
      }),
      { abortSignal: signal },
    );
    count += out.ResourceRecordSets?.length ?? 0;
    startName = out.IsTruncated ? out.NextRecordName : undefined;
    startType = out.IsTruncated ? out.NextRecordType : undefined;
    startIdentifier = out.IsTruncated ? out.NextRecordIdentifier : undefined;
  } while (startName);
  return count;
}

function addFinding(
  findings: Finding[],
  severity: FindingSeverity,
  code: string,
  zone: string,
  message: string,
) {
  findings.push({ severity, code, zone, message });
}

function hasTxtPolicy(
  records: RecordSetSummary[],
  zone: string,
  prefix: string,
  policyPrefix: string,
): boolean {
  const wanted = prefix ? `${prefix}.${zone}` : zone;
  return records.some(
    (r) =>
      r.type === "TXT" &&
      r.name === wanted &&
      r.values.some((value) => value.replace(/^"|"$/g, "").toLowerCase().startsWith(policyPrefix)),
  );
}

/**
 * Inspect a zone's record sets for delegation, TTL and apex health. Mail and
 * website expectation checks are auto-applied when the zone looks like a mail
 * zone (apex MX) or website zone (apex A/AAAA/alias) -- no per-account profile.
 */
export function analyzeRecordSets(
  zone: string,
  records: RecordSetSummary[],
  truncated: boolean,
  maxRecordsAnalyzed: number,
): ZoneAnalysis {
  const findings: Finding[] = [];
  const recordTypes: Record<string, number> = {};
  const apex: ApexFlags = {
    hasA: false,
    hasAAAA: false,
    hasAlias: false,
    hasMX: false,
    hasNS: false,
    hasSOA: false,
  };

  for (const record of records) {
    recordTypes[record.type] = (recordTypes[record.type] ?? 0) + 1;
    if (record.name === zone) {
      if (record.type === "A") apex.hasA = true;
      if (record.type === "AAAA") apex.hasAAAA = true;
      if ((record.type === "A" || record.type === "AAAA") && record.aliasTarget)
        apex.hasAlias = true;
      if (record.type === "MX") apex.hasMX = true;
      if (record.type === "NS") apex.hasNS = true;
      if (record.type === "SOA") apex.hasSOA = true;
    }
    if (record.ttl !== undefined && record.ttl < 60) {
      addFinding(
        findings,
        "warning",
        "ttl_too_low",
        zone,
        `${record.name} ${record.type} TTL is below 60s`,
      );
    }
    if (record.ttl !== undefined && record.ttl > 604_800) {
      addFinding(
        findings,
        "warning",
        "ttl_too_high",
        zone,
        `${record.name} ${record.type} TTL is above 7 days`,
      );
    }
  }

  if (records.length === 0) {
    addFinding(findings, "critical", "empty_zone", zone, "hosted zone has no record sets");
  }
  if (!apex.hasNS)
    addFinding(findings, "critical", "missing_apex_ns", zone, "apex NS record is missing");
  if (!apex.hasSOA)
    addFinding(findings, "critical", "missing_apex_soa", zone, "apex SOA record is missing");
  if (truncated) {
    addFinding(
      findings,
      "info",
      "analysis_truncated",
      zone,
      `analysis stopped after ${maxRecordsAnalyzed} records`,
    );
  }

  // A zone that publishes MX is a mail zone: expect SPF + DMARC policies.
  if (apex.hasMX) {
    if (!hasTxtPolicy(records, zone, "", "v=spf1")) {
      addFinding(
        findings,
        "warning",
        "mail_spf_missing",
        zone,
        "mail zone is missing an SPF (TXT) policy",
      );
    }
    if (!hasTxtPolicy(records, zone, "_dmarc", "v=dmarc1")) {
      addFinding(
        findings,
        "warning",
        "mail_dmarc_missing",
        zone,
        "mail zone is missing a _dmarc TXT policy",
      );
    }
  }

  return { recordCount: records.length, truncated, recordTypes, findings, apex };
}

export async function checkDelegation(zone: string, route53Ns: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (route53Ns.length === 0) return findings;
  try {
    const resolved = await resolveNs(zone);
    const publicNs = resolved.map((ns) => stripDot(ns).toLowerCase()).sort();
    const expected = route53Ns.map((ns) => stripDot(ns).toLowerCase()).sort();
    const missing = expected.filter((ns) => !publicNs.includes(ns));
    if (missing.length > 0) {
      addFinding(
        findings,
        "warning",
        "delegation_mismatch",
        zone,
        `public NS delegation does not match Route 53 (${missing.length} Route 53 nameservers absent)`,
      );
    }
  } catch {
    addFinding(
      findings,
      "warning",
      "delegation_unresolved",
      zone,
      "public NS delegation could not be resolved",
    );
  }
  return findings;
}

/** Returns { signing, findings } so the caller can persist the DNSSEC state. */
export async function checkDnssec(
  client: Route53Client,
  zoneId: string,
  zone: string,
  signal: AbortSignal,
): Promise<{ signing: boolean | null; findings: Finding[] }> {
  try {
    const out = await client.send(new GetDNSSECCommand({ HostedZoneId: zoneId }), {
      abortSignal: signal,
    });
    const signing = out.Status?.ServeSignature === "SIGNING";
    return {
      signing,
      findings: signing
        ? []
        : [
            {
              severity: "info",
              code: "dnssec_not_signing",
              zone,
              message: "DNSSEC signing is not enabled",
            },
          ],
    };
  } catch {
    return {
      signing: null,
      findings: [
        {
          severity: "info",
          code: "dnssec_unknown",
          zone,
          message: "DNSSEC status could not be read",
        },
      ],
    };
  }
}
