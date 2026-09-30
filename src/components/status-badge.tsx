import { cn } from "@/lib/utils";
import type { CheckStatus } from "@/server/connectors/types";

const CONFIG: Record<CheckStatus, { label: string; dot: string; text: string }> = {
  up: { label: "Online", dot: "bg-status-up", text: "text-status-up" },
  down: { label: "Ausfall", dot: "bg-status-down", text: "text-status-down" },
  degraded: { label: "Eingeschränkt", dot: "bg-status-degraded", text: "text-status-degraded" },
  unknown: { label: "Unbekannt", dot: "bg-status-unknown", text: "text-status-unknown" },
};

export function StatusBadge({ status, className }: { status: CheckStatus; className?: string }) {
  const c = CONFIG[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", c.text, className)}>
      <span className={cn("size-2 rounded-full", c.dot)} />
      {c.label}
    </span>
  );
}

export function StatusDot({ status, className }: { status: CheckStatus; className?: string }) {
  return (
    <span className={cn("inline-block size-2.5 rounded-full", CONFIG[status].dot, className)} />
  );
}
