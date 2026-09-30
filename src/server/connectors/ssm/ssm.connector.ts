import {
  DescribeInstanceInformationCommand,
  DescribeInstancePatchesCommand,
  DescribeInstancePatchStatesCommand,
  type InstanceInformation,
  type InstancePatchState,
  type PatchComplianceData,
  SSMClient,
} from "@aws-sdk/client-ssm";
import * as v from "valibot";
import { defineConnector } from "../define";
import type { CheckResult, DiscoveredAsset } from "../types";

const SsmConfig = v.object({
  timeoutMs: v.optional(
    v.pipe(
      v.number(),
      v.minValue(5000),
      v.title("Timeout (ms)"),
      v.description("SSM-Abgleich nach so vielen Millisekunden abbrechen."),
    ),
    60_000,
  ),
  historyDays: v.optional(
    v.pipe(
      v.number(),
      v.minValue(0),
      v.title("Update-Historie (Tage)"),
      v.description(
        "Installierte Patches der letzten N Tage für die Zeitleiste behalten. 0 behält alle.",
      ),
    ),
    180,
  ),
});

const SsmSecret = v.object({
  accessKeyId: v.pipe(v.string(), v.minLength(1), v.title("AWS Access Key ID")),
  secretAccessKey: v.pipe(v.string(), v.minLength(1), v.title("AWS Secret Access Key")),
  region: v.optional(v.pipe(v.string(), v.title("Region")), "eu-central-1"),
});

type Config = v.InferOutput<typeof SsmConfig>;
type Secrets = v.InferOutput<typeof SsmSecret>;

const DAY_MS = 86_400_000;

function credentials(s: Secrets) {
  return { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey };
}

function iso(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

interface PatchOut {
  title: string;
  kbId: string | null;
  classification: string | null;
  severity: string | null;
  installedAt: string | null;
}

interface HostOut {
  instanceId: string;
  computerName: string | null;
  ipAddress: string | null;
  platformName: string | null;
  platformVersion: string | null;
  agentVersion: string | null;
  pingStatus: string | null;
  resourceType: string | null;
  lastPingAt: string | null;
  patch: {
    installed: number | null;
    missing: number | null;
    failed: number | null;
    missingCritical: number | null;
    missingSecurity: number | null;
    lastScanAt: string | null;
  };
  installedPatches: PatchOut[];
  missingPatches: PatchOut[];
}

// Enumerate every managed node the account can see (paginated).
async function listNodes(client: SSMClient, signal: AbortSignal): Promise<InstanceInformation[]> {
  const out: InstanceInformation[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new DescribeInstanceInformationCommand({ MaxResults: 50, NextToken: token }),
      { abortSignal: signal },
    );
    out.push(...(r.InstanceInformationList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

function toPatch(p: PatchComplianceData): PatchOut {
  return {
    title: p.Title ?? "unknown",
    kbId: p.KBId ?? null,
    classification: p.Classification ?? null,
    severity: p.Severity ?? null,
    installedAt: iso(p.InstalledTime),
  };
}

// All patches for one node in a given state (Installed | Missing), paginated.
async function listPatches(
  client: SSMClient,
  instanceId: string,
  state: string,
  signal: AbortSignal,
): Promise<PatchComplianceData[]> {
  const out: PatchComplianceData[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new DescribeInstancePatchesCommand({
        InstanceId: instanceId,
        Filters: [{ Key: "State", Values: [state] }],
        MaxResults: 50,
        NextToken: token,
      }),
      { abortSignal: signal },
    );
    out.push(...(r.Patches ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export const ssmConnector = defineConnector({
  id: "ssm",
  name: "AWS Systems Manager",
  description:
    "Verwaltete Server (EC2 oder hybrid/on-prem) über AWS Systems Manager inventarisieren: Patch-Compliance, ausstehende Updates und Zeitleiste der eingespielten Updates.",
  icon: "ServerCog",
  kind: "source",
  capabilities: { probe: true, inventory: true },
  configSchema: SsmConfig,
  secretSchema: SsmSecret,
  autoAssetTarget: () => "ssm",
  defaultIntervalSeconds: 1800,
  setup: {
    intro:
      "Lege einen lesenden IAM-Zugriffsschlüssel mit Systems-Manager-Leserecht an. Die Server müssen bereits den SSM-Agent ausführen und registriert sein (EC2-Rolle oder Hybrid-Aktivierung für on-prem/andere Clouds).",
    steps: [
      "AWS-Konsole öffnen und zu IAM wechseln (oben nach „IAM“ suchen).",
      "Benutzer, dann Benutzer erstellen. Name „lfio-ssm-readonly“. Keinen Konsolenzugriff aktivieren.",
      "Bei den Berechtigungen „Richtlinien direkt anfügen“ wählen und AmazonSSMReadOnlyAccess anhängen.",
      "Benutzer öffnen, „Sicherheitsanmeldeinformationen“, unter „Zugriffsschlüssel“ einen Zugriffsschlüssel für „Anwendung außerhalb von AWS“ erstellen.",
      "Access Key ID und Secret Access Key unten eintragen und als Region die Region der verwalteten Knoten setzen (z. B. eu-central-1).",
    ],
    docsUrl:
      "https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-managedinstances.html",
  },

  async discover(): Promise<DiscoveredAsset[]> {
    // One asset per account/region. Per-node detail lands on each host CI (an
    // `ssm` resource_sources facet) plus the ssm_patches timeline.
    return [{ name: "SSM managed nodes", target: "ssm" }];
  },

  async check(_target, config: Config, secrets: Secrets, ctx): Promise<CheckResult> {
    const start = performance.now();
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]);
    // Adaptive retry with a higher attempt cap smooths over SSM API throttling
    // ("Rate exceeded") from paginating patches across several nodes each cycle.
    const client = new SSMClient({
      region: secrets.region,
      credentials: credentials(secrets),
      maxAttempts: 8,
      retryMode: "adaptive",
    });
    const cutoff = config.historyDays > 0 ? ctx.now.getTime() - config.historyDays * DAY_MS : 0;

    let nodes: InstanceInformation[];
    try {
      nodes = await listNodes(client, signal);
    } catch (error) {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - start),
        message:
          error instanceof Error ? error.message : "SSM DescribeInstanceInformation fehlgeschlagen",
        raw: { region: secrets.region },
      };
    }

    const ids = nodes.map((n) => n.InstanceId).filter((x): x is string => Boolean(x));

    // Patch-compliance counts for every node (max 50 ids per call).
    const rawStates: Record<string, ReturnType<typeof stateFields>> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await client.send(new DescribeInstancePatchStatesCommand({ InstanceIds: chunk }), {
        abortSignal: signal,
      });
      for (const s of r.InstancePatchStates ?? []) {
        if (s.InstanceId) rawStates[s.InstanceId] = stateFields(s);
      }
    }

    const list: HostOut[] = [];
    let totalMissing = 0;
    let totalCritical = 0;
    let offline = 0;

    for (const n of nodes) {
      const id = n.InstanceId;
      if (!id) continue;
      const st = rawStates[id];
      const missing = st?.missing ?? null;
      const missingCritical = st?.missingCritical ?? null;
      if ((n.PingStatus ?? "") !== "Online") offline += 1;
      if (typeof missing === "number") totalMissing += missing;
      if (typeof missingCritical === "number") totalCritical += missingCritical;

      // Pending updates (small) and the recent applied-update window.
      const [missingRaw, installedRaw] = await Promise.all([
        listPatches(client, id, "Missing", signal),
        listPatches(client, id, "Installed", signal),
      ]);
      const installedPatches = installedRaw
        .map(toPatch)
        .filter((p) => {
          if (!p.installedAt) return false;
          if (cutoff === 0) return true;
          return new Date(p.installedAt).getTime() >= cutoff;
        })
        .sort((a, b) => (b.installedAt ?? "").localeCompare(a.installedAt ?? ""));

      list.push({
        instanceId: id,
        computerName: n.ComputerName ?? null,
        ipAddress: n.IPAddress ?? null,
        platformName: n.PlatformName ?? null,
        platformVersion: n.PlatformVersion ?? null,
        agentVersion: n.AgentVersion ?? null,
        pingStatus: n.PingStatus ?? null,
        resourceType: n.ResourceType ?? null,
        lastPingAt: iso(n.LastPingDateTime),
        patch: {
          installed: st?.installed ?? null,
          missing,
          failed: st?.failed ?? null,
          missingCritical,
          missingSecurity: st?.missingSecurity ?? null,
          lastScanAt: st?.lastScanAt ?? null,
        },
        installedPatches,
        missingPatches: missingRaw.map(toPatch),
      });
    }

    const status: CheckResult["status"] = offline > 0 || totalCritical > 0 ? "degraded" : "up";
    const message = `${nodes.length} ${nodes.length === 1 ? "Knoten" : "Knoten"}, ${totalMissing} ausstehende${
      totalMissing === 1 ? "s Update" : " Updates"
    }${totalCritical > 0 ? ` (${totalCritical} kritisch)` : ""}${offline > 0 ? `, ${offline} offline` : ""}`;

    return {
      status,
      latencyMs: Math.round(performance.now() - start),
      message,
      raw: {
        region: secrets.region,
        hosts: { count: nodes.length, list },
        metrics: [
          metric("nodes", "Verwaltete Knoten", nodes.length, "SSM"),
          metric("pending", "Ausstehende Updates", totalMissing, "SSM"),
          metric("critical", "Kritisch ausstehend", totalCritical, "SSM"),
          metric("offline", "Agenten offline", offline, "SSM"),
        ],
      },
    };
  },
});

function stateFields(s: InstancePatchState) {
  return {
    installed: s.InstalledCount ?? null,
    missing: s.MissingCount ?? null,
    failed: s.FailedCount ?? null,
    missingCritical: s.CriticalNonCompliantCount ?? null,
    missingSecurity: s.SecurityNonCompliantCount ?? null,
    lastScanAt: iso(s.OperationEndTime),
  };
}

function metric(key: string, label: string, value: number, group: string) {
  return { key, label, value, unit: "count", group };
}
