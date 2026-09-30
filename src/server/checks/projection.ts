import type { CheckResult } from "../connectors/types";

export interface ProjectionStageResult {
  ok: boolean;
  checkedAt: string;
  error?: string;
}

interface ProjectionMetadata {
  ok: boolean;
  stages: Record<string, ProjectionStageResult>;
}

// German names for the sync stages, for the user-visible check message. The
// stage keys themselves stay English (metadata, logs).
const STAGE_LABELS: Record<string, string> = {
  "mailcow.inventory": "Mailcow-Inventar",
  "aws.inventory-and-cost": "AWS-Inventar und Kosten",
  "ssm.inventory": "SSM-Inventar",
  "hetzner-cloud.inventory-and-cost": "Hetzner-Inventar und Kosten",
  "railway.inventory-and-cost": "Railway-Inventar und Kosten",
  "tls.certificate": "TLS-Zertifikat",
  "cost.allocation": "Kostenverteilung",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

const MAX_ERROR_LENGTH = 500;

// Drizzle wraps a database error as "Failed query: <sql> params: <values>" and
// keeps the Postgres message on `cause`. The SQL of a bulk insert runs to tens of
// kilobytes and hides the one line that explains the failure, so prefer the cause.
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error || "unknown error");
  const cause = error.cause instanceof Error ? error.cause.message : null;
  const message = cause ?? error.message;
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

function currentProjection(result: CheckResult): ProjectionMetadata {
  const existing = result.raw.sync as ProjectionMetadata | undefined;
  return existing && typeof existing === "object" && existing.stages
    ? existing
    : { ok: true, stages: {} };
}

export function recordProjectionSuccess(result: CheckResult, stage: string, at: Date): CheckResult {
  const projection = currentProjection(result);
  return {
    ...result,
    raw: {
      ...result.raw,
      sync: {
        ok: projection.ok,
        stages: {
          ...projection.stages,
          [stage]: { ok: true, checkedAt: at.toISOString() },
        },
      } satisfies ProjectionMetadata,
    },
  };
}

export function recordProjectionFailure(
  result: CheckResult,
  stage: string,
  error: unknown,
  at: Date,
): CheckResult {
  const projection = currentProjection(result);
  const message = errorMessage(error);
  const failureSummary = `${stageLabel(stage)} fehlgeschlagen`;
  return {
    ...result,
    status: result.status === "up" ? "degraded" : result.status,
    message: result.message ? `${result.message}; ${failureSummary}` : failureSummary,
    raw: {
      ...result.raw,
      sync: {
        ok: false,
        stages: {
          ...projection.stages,
          [stage]: { ok: false, checkedAt: at.toISOString(), error: message },
        },
      } satisfies ProjectionMetadata,
    },
  };
}
