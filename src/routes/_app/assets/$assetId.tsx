import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BellOff, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MetadataView } from "@/components/metadata-view";
import { MetricsPanel, type Metric as MetricsPanelMetric } from "@/components/metrics-panel";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatLatency, relativeTime } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const Route = createFileRoute("/_app/assets/$assetId")({
  component: AssetDetailPage,
});

function AssetDetailPage() {
  const { assetId } = Route.useParams();
  const queryClient = useQueryClient();
  const assetQuery = useQuery(
    orpc.assets.get.queryOptions({ input: { id: assetId }, refetchInterval: 15_000 }),
  );
  const historyQuery = useQuery(
    orpc.checks.history.queryOptions({
      input: { assetId, limit: 100 },
      refetchInterval: 15_000,
    }),
  );
  const uptime24Query = useQuery(
    orpc.checks.uptime.queryOptions({
      input: { assetId, windowHours: 24 },
      refetchInterval: 60_000,
    }),
  );
  const uptime30Query = useQuery(
    orpc.checks.uptime.queryOptions({
      input: { assetId, windowHours: 720 },
      refetchInterval: 60_000,
    }),
  );
  const incidentsQuery = useQuery(
    orpc.incidents.list.queryOptions({ input: { assetId, limit: 20 }, refetchInterval: 30_000 }),
  );

  const runNow = useMutation({
    mutationFn: () => orpcClient.assets.runNow({ id: assetId }),
  });
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => orpcClient.assets.remove({ id: assetId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.assets.key() });
      await navigate({ to: "/assets" });
    },
  });
  const mute = useMutation({
    mutationFn: (until: string | null) => orpcClient.assets.mute({ id: assetId, until }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.assets.get.key() }),
  });

  const asset = assetQuery.data;
  const history = historyQuery.data ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : undefined;
  const latestMeta = (latest?.metadata as Record<string, unknown> | undefined) ?? undefined;
  const metrics = (latestMeta?.metrics as MetricsPanelMetric[] | undefined) ?? [];
  // Everything in the latest metadata except the charted metrics, for the details list.
  const detailMeta = latestMeta
    ? Object.fromEntries(Object.entries(latestMeta).filter(([k]) => k !== "metrics"))
    : undefined;
  const chartData = history.map((r) => ({
    time: new Date(r.checkedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }),
    latency: r.latencyMs,
  }));

  if (!asset) {
    return (
      <div>
        <PageHeader title="Prüfung" />
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      </div>
    );
  }

  const muted = asset.mutedUntil != null && new Date(asset.mutedUntil).getTime() > Date.now();
  const fmtUptime = (p: number | null | undefined) =>
    p == null ? "k. A." : `${p.toFixed(p >= 99.95 ? 0 : 2).replace(".", ",")} %`;
  const incidents = incidentsQuery.data ?? [];

  return (
    <div>
      <PageHeader
        title={asset.name}
        description={asset.target}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
              <RefreshCw className={runNow.isPending ? "animate-spin" : undefined} />
              {runNow.isPending ? "Eingereiht…" : "Jetzt prüfen"}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                mute.mutate(muted ? null : new Date(Date.now() + 24 * 3_600_000).toISOString())
              }
              disabled={mute.isPending}
            >
              <BellOff />
              {muted ? "Stummschaltung aufheben" : "24 h stummschalten"}
            </Button>
            <Button asChild variant="outline">
              <Link to="/assets/edit/$assetId" params={{ assetId }}>
                <Pencil />
                Bearbeiten
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(`„${asset.name}“ löschen? Der Verlauf geht dabei verloren.`))
                  remove.mutate();
              }}
              aria-label="Prüfung löschen"
              title="Prüfung löschen"
            >
              <Trash2 className="text-muted-foreground" />
            </Button>
          </div>
        }
      />
      <div className="space-y-8 p-8">
        <div className="flex flex-wrap items-center gap-6">
          <StatusBadge status={asset.lastStatus} className="text-sm" />
          <Metric label="Latenz" value={formatLatency(asset.lastLatencyMs)} />
          <Metric label="Verfügbarkeit 24 h" value={fmtUptime(uptime24Query.data?.uptimePercent)} />
          <Metric label="Verfügbarkeit 30 d" value={fmtUptime(uptime30Query.data?.uptimePercent)} />
          <Metric label="Letzte Prüfung" value={relativeTime(asset.lastCheckedAt)} />
          <Metric label="Intervall" value={`${asset.intervalSeconds} s`} />
          <Badge variant="muted">{asset.connectorId}</Badge>
          {muted && <Badge variant="outline">Stumm</Badge>}
          {asset.tags.map((t) => (
            <Badge key={t} variant="outline">
              {t}
            </Badge>
          ))}
        </div>

        <Card className="p-5">
          <div className="mb-4 text-sm font-medium text-muted-foreground">Antwortzeit</div>
          <div className="h-64">
            {chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Noch keine Prüfungen aufgezeichnet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <defs>
                    <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 11 }}
                    stroke="var(--color-muted-foreground)"
                    minTickGap={32}
                  />
                  <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" unit="ms" />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="latency"
                    stroke="var(--color-signal)"
                    strokeWidth={2}
                    fill="url(#latencyFill)"
                    dot={false}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {metrics.length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Messwerte</h2>
            <MetricsPanel metrics={metrics} history={history} />
          </div>
        )}

        {detailMeta && Object.keys(detailMeta).length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">
              Letzte Details
              <span className="ml-2 font-normal text-xs">{relativeTime(latest?.checkedAt)}</span>
            </h2>
            <Card className="p-5">
              <MetadataView data={detailMeta} />
            </Card>
          </div>
        )}

        {incidents.length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Störungen</h2>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Beginn</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Dauer</TableHead>
                    <TableHead>Zustand</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidents.map((inc) => {
                    const end = inc.endedAt ? new Date(inc.endedAt) : new Date();
                    const mins = Math.max(
                      1,
                      Math.round((end.getTime() - new Date(inc.startedAt).getTime()) / 60_000),
                    );
                    const dur =
                      mins >= 60 ? `${Math.round(mins / 60)} h ${mins % 60} min` : `${mins} min`;
                    return (
                      <TableRow key={inc.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {relativeTime(inc.startedAt)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={inc.status} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{dur}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {inc.endedAt ? "Behoben" : "Laufend"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          </div>
        )}

        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Letzte Prüfungen</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zeit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latenz</TableHead>
                  <TableHead>Meldung</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...history]
                  .reverse()
                  .slice(0, 30)
                  .map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {relativeTime(r.checkedAt)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {formatLatency(r.latencyMs)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.message}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}
