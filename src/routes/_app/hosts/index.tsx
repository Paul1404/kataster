import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes } from "lucide-react";
import { useState } from "react";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/hosts/")({
  component: HostsPage,
});

function HostsPage() {
  const q = useQuery(orpc.resources.listHosts.queryOptions({ refetchInterval: 30_000 }));
  const hosts = q.data ?? [];
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const shown = hosts.filter(
    (h) =>
      !term ||
      h.name.toLowerCase().includes(term) ||
      (h.ownerName ?? "").toLowerCase().includes(term) ||
      (h.platform ?? "").toLowerCase().includes(term),
  );

  return (
    <div>
      <PageHeader
        title="Hosts"
        description="Server, zugeordnete Kunden und betriebene Container als Grundlage der Kostenverteilung."
      />
      <div className="space-y-4 p-8">
        {hosts.length > 3 && (
          <ListToolbar
            search={search}
            onSearch={setSearch}
            placeholder="Host, Kunde oder System suchen"
          />
        )}
        {hosts.length === 0 ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            {q.isLoading ? "Lade Hosts…" : "Noch keine Hosts aus einer Inventarquelle übernommen."}
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((h) => {
              return (
                <Link key={h.id} to="/ci/$id" params={{ id: h.id }} className="block">
                  <Card className="space-y-3 p-4 transition-colors hover:bg-accent/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{h.name}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {h.platform && <span>{h.platform}</span>}
                      <span>{h.ownerName ?? "nicht zugeordnet"}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Boxes className="size-3.5" />
                        {h.containerCount} Container
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      gesehen {relativeTime(h.lastSeenAt)}
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
