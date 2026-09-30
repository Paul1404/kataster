import { cn } from "@/lib/utils";

export function Progress({
  value,
  className,
  tone,
}: {
  value: number;
  className?: string;
  tone?: "default" | "warn" | "danger";
}) {
  const pct = Math.max(0, Math.min(100, value));
  const resolved = tone ?? (pct >= 90 ? "danger" : pct >= 75 ? "warn" : "default");
  const bar =
    resolved === "danger"
      ? "bg-status-down"
      : resolved === "warn"
        ? "bg-status-degraded"
        : "bg-primary";
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}
