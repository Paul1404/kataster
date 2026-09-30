import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/connections/$connectionId")({
  component: ConnectionDetailPage,
});

function ConnectionDetailPage() {
  const { connectionId } = Route.useParams();
  const q = useQuery(
    orpc.connections.get.queryOptions({
      input: { id: connectionId },
      refetchInterval: 30_000,
    }),
  );

  if (q.isLoading) {
    return (
      <div>
        <PageHeader title="Verbindung" />
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div>
        <PageHeader title="Verbindung" />
        <div className="p-8 text-sm text-muted-foreground">
          {q.isError ? "Diese Verbindung konnte nicht geladen werden. " : "Nicht gefunden. "}
          <Link to="/connections" className="text-primary hover:underline">
            Zurück
          </Link>
        </div>
      </div>
    );
  }

  const c = q.data;

  return (
    <div>
      <PageHeader
        title={c.name}
        description={`${c.connectorName} · angelegt ${relativeTime(c.createdAt)}`}
        actions={
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" asChild>
              <Link to="/connections/edit/$connectionId" params={{ connectionId: c.id }}>
                <Pencil className="size-4" />
                Bearbeiten
              </Link>
            </Button>
            <Link
              to="/connections"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Zurück
            </Link>
          </div>
        }
      />
      <div className="space-y-6 p-8">
        <div className="flex items-center gap-3">
          <ConnectorGlyph connectorId={c.connectorId} className="size-5 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">{c.connectorName}</div>
            {c.connectorDescription && (
              <div className="max-w-2xl text-xs text-muted-foreground">
                {c.connectorDescription}
              </div>
            )}
          </div>
        </div>

        <section className="space-y-2">
          <div className="text-sm font-medium">Genutzt von ({c.assets.length})</div>
          {c.assets.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              Noch keine Prüfung nutzt diese Verbindung.
            </Card>
          ) : (
            <Card className="divide-y divide-border p-0">
              {c.assets.map((a) => (
                <Link
                  key={a.id}
                  to="/assets/$assetId"
                  params={{ assetId: a.id }}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-accent"
                >
                  <StatusDot status={a.lastStatus} />
                  <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                  {!a.enabled && (
                    <span className="shrink-0 text-xs text-muted-foreground">pausiert</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.lastCheckedAt ? relativeTime(a.lastCheckedAt) : "nie geprüft"}
                  </span>
                </Link>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
