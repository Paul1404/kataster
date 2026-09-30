import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";
import { orpc } from "@/lib/orpc";
import type { CheckStatus } from "@/server/connectors/types";

export const Route = createFileRoute("/_app/hosts/")({
  component: HostsPage,
});

function pingToStatus(ping: string | null): CheckStatus {
  if (ping === "Online") return "up";
  if (ping === "ConnectionLost") return "down";
  if (ping === "Inactive") return "degraded";
  return "unknown";
}

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
        description="Deine Server als Configuration Items. Jeder Host vereint alle Quellen, die ihn kennen: Hardware, Patch-Stand, Container und Monitoring an einem Ort."
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
            {q.isLoading
              ? "Lade Hosts…"
              : "Noch keine Hosts gefunden. Sie erscheinen, sobald eine Hetzner- oder Systems-Manager-Verbindung gelaufen ist."}
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((h) => {
              const status = (h.monitorStatus as CheckStatus | null) ?? pingToStatus(h.pingStatus);
              const critical = h.patchMissingCritical ?? 0;
              const missing = h.patchMissing ?? 0;
              return (
                <Link key={h.id} to="/ci/$id" params={{ id: h.id }} className="block">
                  <Card className="space-y-3 p-4 transition-colors hover:bg-accent/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusDot status={status} />
                        <span className="truncate font-medium">{h.name}</span>
                      </div>
                      <StatusBadge status={status} />
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
                      {missing > 0 && (
                        <span
                          className="flex items-center gap-1.5"
                          style={{
                            color:
                              critical > 0
                                ? "var(--color-status-down)"
                                : "var(--color-status-degraded)",
                          }}
                        >
                          <ShieldAlert className="size-3.5" />
                          {missing} ausstehend{critical > 0 ? ` · ${critical} kritisch` : ""}
                        </span>
                      )}
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
