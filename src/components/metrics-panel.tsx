import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { formatBytes, formatNumber } from "@/lib/format";

export interface Metric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  group?: string;
}

interface CheckRow {
  checkedAt: string | Date;
  metadata?: Record<string, unknown> | null;
}

function formatValue(value: number, unit?: string): string {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "%") return `${formatNumber(Math.round(value * 10) / 10)} %`;
  if (unit === "ms") return `${formatNumber(value)} ms`;
  if (!unit || unit === "count") return formatNumber(value);
  return `${formatNumber(value)} ${unit}`;
}

function seriesFor(key: string, history: CheckRow[]): { v: number }[] {
  const points: { v: number }[] = [];
  for (const row of history) {
    const metrics = (row.metadata?.metrics as Metric[] | undefined) ?? [];
    const found = metrics.find((m) => m.key === key);
    if (found && Number.isFinite(found.value)) points.push({ v: found.value });
  }
  return points;
}

function MetricCard({ metric, history }: { metric: Metric; history: CheckRow[] }) {
  const series = seriesFor(metric.key, history);
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{metric.label}</div>
      <div className="mt-1 font-mono text-xl font-semibold">
        {formatValue(metric.value, metric.unit)}
      </div>
      {series.length > 1 && (
        <div className="mt-2 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--color-signal)"
                fill="var(--color-signal)"
                fillOpacity={0.15}
                strokeWidth={1.5}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

export function MetricsPanel({ metrics, history }: { metrics: Metric[]; history: CheckRow[] }) {
  if (metrics.length === 0) return null;

  // Group by optional `group`; ungrouped metrics fall under "Metrics".
  const groups = new Map<string, Metric[]>();
  for (const m of metrics) {
    const g = m.group ?? "Messwerte";
    const list = groups.get(g) ?? [];
    list.push(m);
    groups.set(g, list);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([group, items]) => (
        <div key={group}>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">{group}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((m) => (
              <MetricCard key={m.key} metric={m} history={history} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
