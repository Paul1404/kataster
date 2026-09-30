import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { checkSubtitle, sortChecks } from "@/lib/checks-list";
import { formatInterval, formatLatency, relativeTime } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";
import type { CheckStatus } from "@/server/connectors/types";

export const Route = createFileRoute("/_app/assets/")({
  component: AssetsPage,
});

function AssetsPage() {
  const queryClient = useQueryClient();
  const assetsQuery = useQuery(orpc.assets.list.queryOptions({ refetchInterval: 15_000 }));
  const connectorsQuery = useQuery(orpc.connectors.list.queryOptions());
  const connectorMeta = (id: string) => {
    const c = connectorsQuery.data?.find((x) => x.id === id);
    return { name: c?.name ?? id, kind: c?.kind ?? ("probe" as const) };
  };

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) => orpcClient.assets.toggle(vars),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.assets.key() }),
  });

  const assets = assetsQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [connectorFilter, setConnectorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const term = search.trim().toLowerCase();
  const connectorIds = [...new Set(assets.map((a) => a.connectorId))].sort();
  const shown = sortChecks(
    assets.filter(
      (a) =>
        (connectorFilter === "all" || a.connectorId === connectorFilter) &&
        (statusFilter === "all" || a.lastStatus === statusFilter) &&
        (!term || a.name.toLowerCase().includes(term) || a.target.toLowerCase().includes(term)),
    ),
  );
  const rows = shown.map((a) => {
    const meta = connectorMeta(a.connectorId);
    return {
      ...a,
      kind: meta.kind,
      subtitle: checkSubtitle({
        name: a.name,
        target: a.target,
        connectorName: meta.name,
        kind: meta.kind,
      }),
    };
  });
  const probes = rows.filter((r) => r.kind === "probe");
  const sources = rows.filter((r) => r.kind === "source");
  const onToggle = (id: string, enabled: boolean) => toggle.mutate({ id, enabled });

  return (
    <div>
      <PageHeader
        title="Prüfungen"
        description="Was Kataster überwacht und aus welchen Konten es Inventar und Kosten liest."
        actions={
          <Button asChild>
            <Link to="/assets/new">
              <Plus />
              Prüfung hinzufügen
            </Link>
          </Button>
        }
      />
      <div className="space-y-8 p-8">
        {assets.length > 0 && (
          <ListToolbar search={search} onSearch={setSearch} placeholder="Name oder Ziel suchen">
            <Select value={connectorFilter} onValueChange={setConnectorFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Connectoren</SelectItem>
                {connectorIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {connectorMeta(id).name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Jeder Status</SelectItem>
                <SelectItem value="up">Online</SelectItem>
                <SelectItem value="degraded">Eingeschränkt</SelectItem>
                <SelectItem value="down">Ausfall</SelectItem>
                <SelectItem value="unknown">Unbekannt</SelectItem>
              </SelectContent>
            </Select>
          </ListToolbar>
        )}

        {assets.length === 0 ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            Noch keine Prüfungen. Lege eine an, um mit dem Monitoring zu starten.
          </Card>
        ) : shown.length === 0 ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            Keine Prüfung passt zum Filter.
          </Card>
        ) : (
          <>
            {probes.length > 0 && (
              <Section
                title="Dienste"
                description="Erreichbarkeit einzelner Websites, Server und Mail-Dienste."
              >
                <CheckTable rows={probes} kind="probe" onToggle={onToggle} />
              </Section>
            )}
            {sources.length > 0 && (
              <Section
                title="Datenquellen"
                description="Anbieterkonten, aus denen Kataster Inventar und Kosten liest. Eingeschränkt heißt hier: Die Daten sind nicht aktuell, kein Ausfall eines Dienstes."
              >
                <CheckTable rows={sources} kind="source" onToggle={onToggle} />
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Card>{children}</Card>
    </section>
  );
}

interface CheckRow {
  id: string;
  name: string;
  subtitle: string;
  lastStatus: CheckStatus;
  lastMessage: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: Date | string | null;
  intervalSeconds: number;
  enabled: boolean;
}

function CheckTable({
  rows,
  kind,
  onToggle,
}: {
  rows: CheckRow[];
  kind: "probe" | "source";
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[32%]">Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-24 text-right">
            {kind === "probe" ? "Latenz" : "Intervall"}
          </TableHead>
          <TableHead className="w-32">
            {kind === "probe" ? "Letzte Prüfung" : "Letzter Abgleich"}
          </TableHead>
          <TableHead className="w-16 text-right">Aktiv</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          // A healthy probe needs no explanation; a source's message is its
          // inventory summary ("12 Projekte · 34 Services"), useful either way.
          const reason = row.lastStatus !== "up" || kind === "source" ? row.lastMessage : null;
          return (
            <TableRow key={row.id} className={row.enabled ? undefined : "opacity-60"}>
              <TableCell className="min-w-0">
                <Link
                  to="/assets/$assetId"
                  params={{ assetId: row.id }}
                  className="block truncate font-medium hover:underline"
                >
                  {row.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{row.subtitle}</div>
              </TableCell>
              <TableCell className="min-w-0">
                <StatusBadge status={row.lastStatus} />
                {reason && (
                  <div className="truncate text-xs text-muted-foreground" title={reason}>
                    {reason}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                {kind === "probe"
                  ? formatLatency(row.lastLatencyMs)
                  : formatInterval(row.intervalSeconds)}
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {relativeTime(row.lastCheckedAt)}
              </TableCell>
              <TableCell className="text-right">
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(enabled) => onToggle(row.id, enabled)}
                  aria-label={row.enabled ? "Prüfung deaktivieren" : "Prüfung aktivieren"}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
