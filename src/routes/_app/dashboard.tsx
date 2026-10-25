import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, CheckCircle2, History, Info, OctagonAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { type ActionItem, type ActionSeverity, buildActionItems } from "@/lib/cockpit-actions";
import {
  formatEuro,
  formatNumber,
  formatPeriod,
  relativeTime,
  resourceTypeLabel,
} from "@/lib/format";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
});

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
              <span>Keine offenen Zuordnungen oder Abrechnungslücken.</span>
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
