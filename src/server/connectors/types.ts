import type { GenericSchema, InferOutput } from "valibot";

export type CheckStatus = "up" | "down" | "degraded" | "unknown";

export interface CheckResult {
  status: CheckStatus;
  /** Round-trip latency in ms, or null when not measurable. */
  latencyMs: number | null;
  /** Short human summary shown in the UI. */
  message: string | null;
  /** Connector-specific metadata, persisted as jsonb. */
  raw: Record<string, unknown>;
}

export interface CheckContext {
  signal: AbortSignal;
  now: Date;
}

export type ConnectorKind = "probe" | "source";

export interface ConnectorCapabilities {
  /** Runs live health/status checks. */
  probe: boolean;
  /** Can pull a list of assets from a source (discover). */
  inventory: boolean;
}

export interface DiscoveredAsset {
  name: string;
  target: string;
  suggestedConfig?: Record<string, unknown>;
}

/** Optional human setup guide shown in the UI when configuring a connector. */
export interface ConnectorSetup {
  intro?: string;
  steps: string[];
  /** A copy-pasteable shell snippet run on the host/console to do the setup. */
  commands?: string;
  docsUrl?: string;
}

/** No-secret connectors receive this empty object as their secrets argument. */
export type EmptySecrets = Record<string, never>;

type SecretsArg<TSecret extends GenericSchema | undefined> = TSecret extends GenericSchema
  ? InferOutput<TSecret>
  : EmptySecrets;

/**
 * A connector definition. Generic over its config schema (and optional secret
 * schema for credentialed connectors). Authored with defineConnector to keep
 * inference; stored in the registry as the type-erased AnyConnector.
 */
export interface Connector<
  TConfig extends GenericSchema = GenericSchema,
  TSecret extends GenericSchema | undefined = undefined,
> {
  id: string;
  name: string;
  description: string;
  /** lucide-react icon name, resolved client-side. */
  icon: string;
  /**
   * What a check of this connector is. `probe`: a health check of one service
   * (a website, a mail server). `source`: the sync of a whole provider account
   * that feeds inventory and cost (AWS, Railway, Hetzner Cloud, SSM). The UI
   * lists the two apart; a degraded source means stale data, not an outage.
   */
  kind: ConnectorKind;
  capabilities: ConnectorCapabilities;
  /** Non-secret per-asset settings. Drives the UI form and is validated server-side. */
  configSchema: TConfig;
  /** Credential schema. Present only for connectors that need authentication. */
  secretSchema?: TSecret;
  /** Optional step-by-step guide for obtaining credentials / configuring the target. */
  setup?: ConnectorSetup;
  /**
   * Single-target connectors (one connection == one asset) can auto-create the
   * asset on connection create. Returns the asset target derived from the
   * connection name (e.g. the host FQDN, or a fixed value like "railway").
   */
  autoAssetTarget?: (connectionName: string) => string;
  /**
   * Default check cadence for new assets, in seconds. Health probes keep the
   * 60 s default; inventory/cost connectors (AWS, SSM, Railway, Hetzner Cloud)
   * change slowly and each run is API-heavy, so they default to 15 to 30 min.
   * Fewer runs mean less worker memory churn and fewer check_results rows.
   */
  defaultIntervalSeconds?: number;

  check(
    target: string,
    config: InferOutput<TConfig>,
    secrets: SecretsArg<TSecret>,
    ctx: CheckContext,
  ): Promise<CheckResult>;

  discover?(
    config: InferOutput<TConfig>,
    secrets: SecretsArg<TSecret>,
    ctx: CheckContext,
  ): Promise<DiscoveredAsset[]>;
}

/**
 * Type-erased connector for heterogeneous storage in the registry. Typed
 * connectors are assignable to this thanks to method-parameter bivariance.
 */
export interface AnyConnector {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: ConnectorKind;
  capabilities: ConnectorCapabilities;
  configSchema: GenericSchema;
  secretSchema?: GenericSchema;
  setup?: ConnectorSetup;
  autoAssetTarget?: (connectionName: string) => string;
  defaultIntervalSeconds?: number;
  check(target: string, config: any, secrets: any, ctx: CheckContext): Promise<CheckResult>;
  discover?(config: any, secrets: any, ctx: CheckContext): Promise<DiscoveredAsset[]>;
}
