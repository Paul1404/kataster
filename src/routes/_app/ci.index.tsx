import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AtSign, Globe, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { daysUntil, expiryColor } from "@/lib/customer";
import { relativeTime } from "@/lib/format";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/ci/")({
  component: DomainsPage,
});

function DomainsPage() {
  const q = useQuery(orpc.resources.listDomains.queryOptions({ refetchInterval: 60_000 }));
  const domains = q.data ?? [];
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const owners = useMemo(
    () => [...new Set(domains.map((d) => d.ownerName).filter(Boolean))].sort() as string[],
    [domains],
  );
  const term = search.trim().toLowerCase();
  const shown = domains.filter(
    (d) =>
      (ownerFilter === "all" ||
        (ownerFilter === "unassigned" ? !d.ownerName : d.ownerName === ownerFilter)) &&
      (!term || d.name.includes(term) || (d.ownerName ?? "").toLowerCase().includes(term)),
  );

  return (
    <div>
      <PageHeader
        title="Domains"
        description="Jede Domain als ein Configuration Item, zusammengeführt aus Registrar, DNS, SES, CloudFront, ACM und Mailcow."
      />
      <div className="space-y-4 p-8">
        {domains.length > 0 && (
          <ListToolbar search={search} onSearch={setSearch} placeholder="Domain oder Kunde suchen">
            <Select value={ownerFilter} onValueChange={setOwnerFilter}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Eigentümer</SelectItem>
                <SelectItem value="unassigned">Nicht zugeordnet</SelectItem>
                {owners.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ListToolbar>
        )}
        {domains.length === 0 ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            {q.isLoading ? "Lade Domains…" : "Noch keine Domains gefunden."}
          </Card>
        ) : shown.length === 0 ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            Keine Domain passt zum Filter.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((d) => {
              const days = daysUntil(d.expiresAt);
              return (
                <Link key={d.id} to="/ci/$id" params={{ id: d.id }} className="block">
                  <Card className="space-y-3 p-4 transition-colors hover:bg-accent/50">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {d.ownerName ?? "nicht zugeordnet"}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {d.registrar && (
                        <span className="flex items-center gap-1">
                          <ShieldCheck className="size-3.5" />
                          {d.registrar}
                        </span>
                      )}
                      {d.cloudfront && (
                        <span className="flex items-center gap-1">
                          <Globe className="size-3.5" />
                          CloudFront{d.cloudfront === "redirect" ? " · Weiterleitung" : ""}
                        </span>
                      )}
                      {d.mailboxCount != null && (
                        <span className="flex items-center gap-1">
                          <AtSign className="size-3.5" />
                          {d.mailboxCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      {days != null ? (
                        <span style={{ color: expiryColor(days) }}>
                          {days < 0 ? "abgelaufen" : `verlängert in ${days} d`}
                        </span>
                      ) : (
                        <span />
                      )}
                      <span>gesehen {relativeTime(d.lastSeenAt)}</span>
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
