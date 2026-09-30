import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import * as v from "valibot";
import { BulkAssignBar } from "@/components/bulk-assign-bar";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatEuro, formatPeriod, relativeTime, resourceTypeLabel } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";
import { useSelection } from "@/lib/use-selection";
import { cn } from "@/lib/utils";

// The whole view lives in the URL, so a filtered list is a shareable link.
const SearchSchema = v.object({
  q: v.optional(v.string()),
  type: v.optional(v.string()),
  provider: v.optional(v.string()),
  owner: v.optional(v.string()), // customer id | "unassigned"
  status: v.optional(v.picklist(["active", "decommissioned", "all"])),
  sort: v.optional(v.picklist(["name", "cost", "seen", "type"])),
});
type Search = v.InferOutput<typeof SearchSchema>;

export const Route = createFileRoute("/_app/objects")({
  validateSearch: (raw) => v.parse(SearchSchema, raw),
  component: ObjectsPage,
});

const STATUS_LABEL: Record<string, string> = { active: "aktiv", decommissioned: "stillgelegt" };

function ObjectsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const q = useQuery(orpc.resources.explore.queryOptions({ refetchInterval: 60_000 }));
  const customersQuery = useQuery(orpc.customers.list.queryOptions());
  const customers = (customersQuery.data ?? []).map((c) => ({ id: c.id, name: c.name }));
  const [busy, setBusy] = useState(false);

  const rows = q.data?.rows ?? [];
  const period = q.data?.period ?? "";
  const status = search.status ?? "active";
  const sort = search.sort ?? "type";

  const set = (patch: Partial<Search>) =>
    navigate({
      search: (prev) => {
        const next = { ...prev, ...patch };
        for (const k of Object.keys(next) as (keyof Search)[]) {
          if (next[k] === "" || next[k] === undefined || next[k] === "all") delete next[k];
        }
        return next;
      },
      replace: true,
    });

  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))].sort(), [rows]);

  const shown = useMemo(() => {
    const term = (search.q ?? "").trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!search.type || r.type === search.type) &&
        (!search.provider || r.provider === search.provider) &&
        (!search.owner ||
          (search.owner === "unassigned"
            ? !r.ownerCustomerId
            : r.ownerCustomerId === search.owner)) &&
        (!term ||
          r.name.toLowerCase().includes(term) ||
          r.externalId.toLowerCase().includes(term) ||
          (r.ownerName ?? "").toLowerCase().includes(term) ||
          (r.parentName ?? "").toLowerCase().includes(term)),
    );
    const by: Record<string, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      cost: (a, b) => b.costCents - a.costCents || a.name.localeCompare(b.name),
      seen: (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [rows, search, status, sort]);

  const shownIds = useMemo(() => shown.map((r) => r.id), [shown]);
  const sel = useSelection(shownIds);
  const totalCost = shown.reduce((s, r) => s + r.costCents, 0);

  async function run(label: string, fn: () => Promise<number>) {
    setBusy(true);
    try {
      const n = await fn();
      toast.success(`${n} ${n === 1 ? "Objekt" : "Objekte"} ${label}.`);
      sel.clear();
      await Promise.all([
        qc.invalidateQueries({ queryKey: orpc.resources.key() }),
        qc.invalidateQueries({ queryKey: orpc.billing.key() }),
        qc.invalidateQueries({ queryKey: orpc.customers.key() }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }
  const assign = (customerId: string | null) =>
    run(customerId ? "zugeordnet" : "freigegeben", async () => {
      const r = await orpcClient.resources.assignOwners({
        resourceIds: [...sel.selected],
        customerId,
      });
      return r.updated;
    });
  const setStatus = (next: "active" | "decommissioned") =>
    run(next === "active" ? "reaktiviert" : "stillgelegt", async () => {
      const r = await orpcClient.resources.setStatus({
        resourceIds: [...sel.selected],
        status: next,
      });
      return r.updated;
    });

  return (
    <div>
      <PageHeader
        title="Objekte"
        description="Alle Configuration Items in einer Ansicht: filtern, auswählen, zuordnen. Die Filter stehen in der URL und lassen sich als Link teilen."
      />
      <div className="space-y-4 p-8">
        <ListToolbar
          search={search.q ?? ""}
          onSearch={(q) => set({ q })}
          placeholder="Name, Kennung, Kunde oder übergeordnetes Objekt"
        >
          <Select value={search.type ?? "all"} onValueChange={(type) => set({ type })}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Typen</SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {resourceTypeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={search.provider ?? "all"} onValueChange={(provider) => set({ provider })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Anbieter</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={search.owner ?? "all"} onValueChange={(owner) => set({ owner })}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Eigentümer</SelectItem>
              <SelectItem value="unassigned">Nicht zugeordnet</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(s) => set({ status: s as Search["status"] })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Aktiv</SelectItem>
              <SelectItem value="decommissioned">Stillgelegt</SelectItem>
              <SelectItem value="all">Alle Status</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(s) => set({ sort: s as Search["sort"] })}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="type">Nach Typ</SelectItem>
              <SelectItem value="name">Nach Name</SelectItem>
              <SelectItem value="cost">Nach Kosten</SelectItem>
              <SelectItem value="seen">Zuletzt gesehen</SelectItem>
            </SelectContent>
          </Select>
        </ListToolbar>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {shown.length} von {rows.length} Objekten
          </span>
          {period && (
            <span>
              Kosten {formatPeriod(period)}: {formatEuro(totalCost)}
            </span>
          )}
        </div>

        <Card className="overflow-hidden p-0">
          {q.isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Lade Objekte…</div>
          ) : shown.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Kein Objekt passt zum Filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={sel.allSelected}
                        onChange={sel.allSelected ? sel.clear : sel.selectAll}
                        aria-label="Alle sichtbaren wählen"
                      />
                    </th>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Typ</th>
                    <th className="px-4 py-2 text-left font-medium">Eigentümer</th>
                    <th className="px-4 py-2 text-left font-medium">Gehört zu</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Kosten</th>
                    <th className="px-4 py-2 text-right font-medium">Gesehen</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const selected = sel.selected.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b border-border/50 last:border-0",
                          selected ? "bg-primary/5" : "hover:bg-accent/30",
                          r.status === "decommissioned" && "text-muted-foreground",
                        )}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={selected}
                            onChange={() => sel.toggle(r.id)}
                            aria-label={`${r.name} wählen`}
                          />
                        </td>
                        <td className="max-w-[20rem] px-4 py-2">
                          <Link
                            to="/ci/$id"
                            params={{ id: r.id }}
                            className="flex items-center gap-2 hover:underline"
                          >
                            <ConnectorGlyph
                              connectorId={r.provider}
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span className="truncate font-medium" title={r.externalId}>
                              {r.name}
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-xs">{resourceTypeLabel(r.type)}</td>
                        <td className="max-w-[12rem] truncate px-4 py-2 text-xs">
                          {r.ownerName ?? <span className="text-amber-500">nicht zugeordnet</span>}
                        </td>
                        <td className="max-w-[12rem] truncate px-4 py-2 text-xs text-muted-foreground">
                          {r.parentName ?? ""}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={r.status === "active" ? "muted" : "outline"}>
                            {STATUS_LABEL[r.status] ?? r.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.costCents > 0 ? formatEuro(r.costCents) : ""}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                          {relativeTime(r.lastSeenAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {shown.length > 0 && (
          <BulkAssignBar
            selectedCount={sel.selected.size}
            visibleCount={shown.length}
            allSelected={sel.allSelected}
            onSelectAll={sel.selectAll}
            onClear={sel.clear}
            customers={customers}
            onAssign={assign}
            allowUnassign
            busy={busy}
            extra={
              sel.selected.size > 0 && (
                <>
                  {status !== "decommissioned" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setStatus("decommissioned")}
                    >
                      <Archive className="size-4" />
                      Stilllegen
                    </Button>
                  )}
                  {status !== "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setStatus("active")}
                    >
                      <ArchiveRestore className="size-4" />
                      Reaktivieren
                    </Button>
                  )}
                </>
              )
            }
          />
        )}
      </div>
    </div>
  );
}
