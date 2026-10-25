import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { isFinopsSource } from "@/lib/finops-sources";
import { relativeTime } from "@/lib/format";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/sources")({ component: SourcesPage });
function SourcesPage() {
  const query = useQuery(orpc.assets.list.queryOptions({ refetchInterval: 60_000 }));
  const sources = (query.data ?? []).filter((s) => s.enabled && isFinopsSource(s.connectorId));
  return (
    <div>
      <PageHeader
        title="Datenquellen"
        description="Woher Inventar und Kosten stammen und wann sie zuletzt abgeglichen wurden."
      />
      <div className="space-y-4 p-8">
        <Link to="/connections" className="text-sm text-primary hover:underline">
          Verbindungen verwalten
        </Link>
        {query.isError && <p>Die Datenquellen konnten nicht geladen werden.</p>}
        {sources.map((source) => (
          <Card key={source.id} className="space-y-2 p-5">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-medium">{source.name}</h2>
              <span className="text-xs text-muted-foreground">
                Letzter Abgleich: {relativeTime(source.lastCheckedAt)}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {source.lastStatus === "up"
                ? "Daten übernommen"
                : source.lastStatus === "degraded"
                  ? "Daten unvollständig"
                  : source.lastStatus === "down"
                    ? "Abgleich fehlgeschlagen"
                    : "Noch kein aktueller Datenstand"}
            </p>
            {source.lastMessage && <p className="text-sm">{source.lastMessage}</p>}
          </Card>
        ))}
        {!query.isLoading && sources.length === 0 && <p>Noch keine Datenquellen verbunden.</p>}
      </div>
    </div>
  );
}
