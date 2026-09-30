import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, CheckCircle2, History, Info, OctagonAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { type ActionItem, type ActionSeverity, buildActionItems } from "@/lib/cockpit-actions";
import {
  formatBytes,
  formatEuro,
  formatLatency,
  formatNumber,
  formatPeriod,
  relativeTime,
  resourceTypeLabel,
} from "@/lib/format";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import type { CheckStatus } from "@/server/connectors/types";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
});

const STATUS_TILES: { key: CheckStatus; label: string; dot: string }[] = [
  { key: "up", label: "Online", dot: "bg-status-up" },
  { key: "degraded", label: "Eingeschränkt", dot: "bg-status-degraded" },
  { key: "down", label: "Ausfall", dot: "bg-status-down" },
  { key: "unknown", label: "Unbekannt", dot: "bg-status-unknown" },
];

const HISTORY_FIELD_LABEL: Record<string, string> = {
  owner: "Eigentümer",
  status: "Status",
  name: "Name",
};

const SEVERITY_STYLE: Record<ActionSeverity, { icon: typeof AlertTriangle; className: string }> = {
  critical: { icon: OctagonAlert, className: "text-status-down" },
  warning: { icon: AlertTriangle, className: "text-status-degraded" },
  info: { icon: Info, className: "text-muted-foreground" },
};

function DashboardPage() {
  const { data, isLoading, isError } = useQuery(
    orpc.dashboard.cockpit.queryOptions({ refetchInterval: 30_000 }),
  );

  const actions = data ? buildActionItems(data.attention) : [];
  const period = data?.period ?? "";

  return (
    <div>
      <PageHeader
        title="Übersicht"
        description="Was jetzt zu tun ist und wie der laufende Monat steht."
      />
      <div className="space-y-8 p-8">
        {isError && (
          <Card className="p-5 text-sm text-red-500">
            Übersicht konnte nicht geladen werden. Bitte erneut versuchen.
          </Card>
        )}

        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {period ? formatPeriod(period) : "Laufender Monat"}
          </h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MoneyTile
              label="Kosten"
              value={data ? formatEuro(data.money.costCents) : null}
              hint="Was die Anbieter kosten."
            />
            <MoneyTile
              label="Berechnet"
              value={data ? formatEuro(data.money.chargeCents) : null}
              hint="Was Kunden in diesem Zeitraum zahlen."
            />
            <MoneyTile
              label="Marge"
              value={data ? formatEuro(data.money.marginCents) : null}
              hint="Berechnet minus Kosten."
              tone={data && data.money.marginCents < 0 ? "negative" : "default"}
            />
            <MoneyTile
              label="Eigenaufwand"
              value={data ? formatEuro(data.money.overheadCents) : null}
              hint="Kosten ohne zahlenden Kunden."
              tone={data && data.money.overheadCents > 0 ? "warn" : "default"}
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Handlungsbedarf</h2>
          {isLoading ? (
            <Card className="p-5 text-sm text-muted-foreground">Lade Übersicht…</Card>
          ) : actions.length === 0 ? (
            <Card className="flex items-center gap-3 p-5 text-sm">
              <CheckCircle2 className="size-4 text-status-up" />
              <span>Nichts offen. Zuordnung, Preise, Laufzeiten und Prüfungen sind sauber.</span>
            </Card>
          ) : (
            <Card className="divide-y divide-border">
              {actions.map((item) => (
                <ActionRow key={item.id} item={item} />
              ))}
            </Card>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Inventar</h2>
            <Link to="/objects" className="text-xs text-muted-foreground hover:text-foreground">
              Alle Objekte
            </Link>
          </div>
          {data && data.inventory.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {data.inventory.map((row) => (
                <Link
                  key={row.type}
                  to="/objects"
                  search={{ type: row.type }}
                  className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <div className="truncate text-xs text-muted-foreground" title={row.type}>
                    {resourceTypeLabel(row.type)}
                  </div>
                  <div className="mt-1 font-mono text-2xl font-semibold">
                    {formatNumber(row.count)}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="p-5 text-sm text-muted-foreground">
              Noch keine aktiven Objekte erfasst.
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <History className="size-4" />
            Letzte Änderungen
          </h2>
          <Card>
            {data && data.changes.length > 0 ? (
              <div className="divide-y divide-border">
                {data.changes.map((change) => (
                  <Link
                    key={change.id}
                    to="/ci/$id"
                    params={{ id: change.resourceId }}
                    className="flex items-center justify-between gap-4 px-5 py-3 text-sm transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {change.resourceName ?? "Objekt"}
                        {change.resourceType && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {resourceTypeLabel(change.resourceType)}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {HISTORY_FIELD_LABEL[change.field] ?? change.field}:{" "}
                        {change.oldValue ?? "leer"} auf {change.newValue ?? "leer"}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <div>{actorLabel(change.actor)}</div>
                      <div className="font-mono">{relativeTime(change.createdAt)}</div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-5 text-sm text-muted-foreground">
                Noch keine Änderungen erfasst.
              </div>
            )}
          </Card>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Monitoring</h2>
            <Link to="/assets" className="text-xs text-muted-foreground hover:text-foreground">
              Zu den Prüfungen
            </Link>
          </div>
          <Card className="p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {STATUS_TILES.map((tile) => (
                <div key={tile.key} className="flex items-center gap-2">
                  <span className={cn("size-2.5 rounded-full", tile.dot)} />
                  <span className="text-xs text-muted-foreground">{tile.label}</span>
                  <span className="font-mono text-sm font-semibold">
                    {data ? data.monitoring.totals[tile.key] : "·"}
                  </span>
                </div>
              ))}
            </div>
            {data && data.monitoring.failing.length > 0 && (
              <div className="mt-4 divide-y divide-border border-t border-border">
                {data.monitoring.failing.map((asset) => (
                  <Link
                    key={asset.id}
                    to="/assets/$assetId"
                    params={{ assetId: asset.id }}
                    className="flex items-center justify-between gap-4 py-2.5 text-sm transition-colors hover:text-foreground"
                  >
                    <span className="min-w-0 truncate font-medium">{asset.name}</span>
                    <span className="flex shrink-0 items-center gap-4">
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatLatency(asset.lastLatencyMs)}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {relativeTime(asset.lastCheckedAt)}
                      </span>
                      <StatusBadge status={asset.lastStatus} />
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </section>

        {data && data.monitoring.mailcow.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Mailserver</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {data.monitoring.mailcow.map((server) => (
                <MailcowCard
                  key={server.id}
                  id={server.id}
                  name={server.name}
                  status={server.status}
                  metadata={server.metadata as Record<string, unknown> | null}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MoneyTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | null;
  hint: string;
  tone?: "default" | "negative" | "warn";
}) {
  return (
    <Card className="p-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div
        className="mt-2 font-mono text-2xl font-semibold tabular-nums"
        style={
          tone === "negative"
            ? { color: "var(--color-status-down)" }
            : tone === "warn"
              ? { color: "var(--color-status-degraded)" }
              : undefined
        }
      >
        {value ?? "·"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </Card>
  );
}

function ActionRow({ item }: { item: ActionItem }) {
  const { icon: Icon, className } = SEVERITY_STYLE[item.severity];
  return (
    <Link
      to={item.link.to}
      search={item.link.search ?? {}}
      className="flex items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-muted/40"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{item.title}</div>
          <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
        </div>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

function actorLabel(actor: string): string {
  if (actor === "worker") return "Worker";
  if (actor.startsWith("user:")) return actor.slice("user:".length);
  if (actor.startsWith("mcp")) return "MCP";
  return actor;
}

function MailcowCard({
  id,
  name,
  status,
  metadata,
}: {
  id: string;
  name: string;
  status: CheckStatus;
  metadata: Record<string, unknown> | null;
}) {
  const mailboxes = metadata?.mailboxes as { count?: number; quotaUsedBytes?: number } | undefined;
  const domains = metadata?.domains as { count?: number } | undefined;
  const aliases = metadata?.aliases as { count?: number } | undefined;
  const storage = metadata?.storage as
    | { used?: string; total?: string; usedPercent?: string }
    | undefined;
  const diskPct = storage?.usedPercent ? Number.parseInt(String(storage.usedPercent), 10) : null;

  const stats = [
    { label: "Domains", value: formatNumber(domains?.count ?? 0) },
    { label: "Postfächer", value: formatNumber(mailboxes?.count ?? 0) },
    { label: "Aliasse", value: formatNumber(aliases?.count ?? 0) },
    {
      label: "Belegter Speicher",
      value: mailboxes?.quotaUsedBytes != null ? formatBytes(mailboxes.quotaUsedBytes) : "k. A.",
    },
  ];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <Link
          to="/assets/$assetId"
          params={{ assetId: id }}
          className="font-medium hover:underline"
        >
          {name}
        </Link>
        <StatusBadge status={status} />
      </div>
      <div className="grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold">{s.value}</div>
          </div>
        ))}
      </div>
      {diskPct !== null && storage && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Speicher</span>
            <span className="font-mono">
              {storage.used} / {storage.total} ({diskPct} %)
            </span>
          </div>
          <Progress value={diskPct} />
        </div>
      )}
    </Card>
  );
}
