import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatNumber } from "@/lib/format";

function humanize(key: string): string {
  const base = key.replace(/Bytes$/i, "");
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatScalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return "k. A.";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  if (typeof value === "number") {
    if (/bytes$/i.test(key)) return formatBytes(value);
    return formatNumber(value);
  }
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}
function isStorage(value: Record<string, unknown>): boolean {
  return "usedPercent" in value || ("used" in value && "total" in value);
}

interface Kpi {
  label: string;
  value: string;
}
interface Bar {
  label: string;
  percent: number;
  caption: string;
}
interface TableBlock {
  title: string;
  rows: Record<string, unknown>[];
}

function collect(data: Record<string, unknown>) {
  const kpis: Kpi[] = [];
  const bars: Bar[] = [];
  const tables: TableBlock[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    if (isObjectArray(value)) {
      tables.push({ title: humanize(key), rows: value });
      continue;
    }
    if (Array.isArray(value)) {
      kpis.push({ label: humanize(key), value: value.map(String).join(", ") || "keine" });
      continue;
    }
    if (isPlainObject(value)) {
      // Pull nested arrays-of-objects into tables (e.g. domains.list).
      for (const childVal of Object.values(value)) {
        if (isObjectArray(childVal)) {
          tables.push({ title: humanize(key), rows: childVal });
        }
      }
      if (isStorage(value)) {
        const percent = Number.parseInt(String(value.usedPercent ?? "0"), 10) || 0;
        bars.push({
          label: humanize(key),
          percent,
          caption: `${value.used ?? "?"} / ${value.total ?? "?"}`,
        });
        continue;
      }
      const scalars = Object.entries(value).filter(
        ([, v]) => v !== null && v !== undefined && !Array.isArray(v) && !isPlainObject(v),
      );
      const keys = scalars.map(([k]) => k);
      if (keys.length === 1 && keys[0] === "count") {
        kpis.push({ label: humanize(key), value: formatScalar("count", value.count) });
      } else if (keys.includes("running") && keys.includes("total")) {
        kpis.push({ label: humanize(key), value: `${value.running} / ${value.total}` });
      } else {
        for (const [k, v] of scalars) {
          kpis.push({
            label: k === "count" ? humanize(key) : `${humanize(key)} ${humanize(k)}`,
            value: formatScalar(k, v),
          });
        }
      }
      continue;
    }
    kpis.push({ label: humanize(key), value: formatScalar(key, value) });
  }
  return { kpis, bars, tables };
}

export function MetadataView({ data }: { data: Record<string, unknown> | null | undefined }) {
  if (!data || Object.keys(data).length === 0) {
    return <p className="text-sm text-muted-foreground">Keine Details gemeldet.</p>;
  }
  const { kpis, bars, tables } = collect(data);

  return (
    <div className="space-y-6">
      {kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {kpis.map((kpi) => (
            <Card key={kpi.label} className="p-4">
              <div className="text-xs text-muted-foreground">{kpi.label}</div>
              <div className="mt-1 font-mono text-lg font-semibold">{kpi.value}</div>
            </Card>
          ))}
        </div>
      )}

      {bars.map((bar) => (
        <div key={bar.label} className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">{bar.label}</span>
            <span className="font-mono text-xs">
              {bar.caption} ({bar.percent} %)
            </span>
          </div>
          <Progress value={bar.percent} />
        </div>
      ))}

      {tables.map((block) => (
        <div key={block.title} className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {block.title}
          </div>
          <Card>
            <MetaTable rows={block.rows} />
          </Card>
        </div>
      ))}
    </div>
  );
}

// Checkmk-style service states get a coloured dot instead of a bare label.
const STATE_DOT: Record<string, string> = {
  OK: "bg-emerald-500",
  WARN: "bg-amber-500",
  CRIT: "bg-red-500",
  UNKNOWN: "bg-slate-400",
};
function StateBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-sans">
      <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[label] ?? "bg-slate-400"}`} />
      {label}
    </span>
  );
}

function MetaTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c}>{humanize(c)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, i) => {
          const rowKey = columns[0] ? String(row[columns[0]] ?? i) : String(i);
          return (
            <TableRow key={rowKey}>
              {columns.map((c) => (
                <TableCell key={c} className="font-mono text-xs">
                  {c === "state" && typeof row[c] === "string" && row[c] in STATE_DOT ? (
                    <StateBadge label={row[c] as string} />
                  ) : (
                    formatScalar(c, row[c])
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
