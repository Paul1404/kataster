import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, History, PackageCheck, Server, ShieldAlert } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { BulkAssignBar } from "@/components/bulk-assign-bar";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
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
import {
  formatBytes,
  formatDateTime,
  formatEuro,
  formatLatency,
  relativeTime,
  resourceTypeLabel,
} from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";
import { useSelection } from "@/lib/use-selection";
import type { CheckStatus } from "@/server/connectors/types";

const NONE = "__none__";
const FACET_TITLES: Record<string, string> = {
  hetzner: "Host (SSH)",
  ssm: "Patches und Inventar (SSM)",
  hetznerCloud: "Hetzner Cloud",
  registry: "Registrar",
  dns: "DNS (Route 53)",
  ses: "E-Mail (SES)",
  cloudfront: "CloudFront",
  acm: "TLS-Zertifikat (ACM)",
  mailcow: "Mail (mailcow)",
};

const HISTORY_FIELD: Record<string, string> = {
  owner: "Eigentümer",
  status: "Status",
  name: "Name",
};
function actorLabel(actor: string): string {
  if (actor === "worker") return "Worker";
  if (actor.startsWith("mcp")) return "MCP";
  if (actor.startsWith("user:")) return actor.slice(5);
  return actor;
}

function pingToStatus(ping: string | null | undefined): CheckStatus {
  if (ping === "Online") return "up";
  if (ping === "ConnectionLost") return "down";
  if (ping === "Inactive") return "degraded";
  return "unknown";
}

function labelize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatVal(key: string, v: unknown): string {
  if (v == null) return "k. A.";
  if (typeof v === "number") {
    if (key.endsWith("Cents")) return formatEuro(v);
    if (key.endsWith("Bytes")) return formatBytes(v);
  }
  if (key.endsWith("At") && typeof v === "string") return relativeTime(v);
  if (typeof v === "boolean") return v ? "ja" : "nein";
  if (Array.isArray(v)) return v.join(", ") || "k. A.";
  return String(v);
}

/** One detail view for any Configuration Item (host or domain), rendered from
 * resources.get: per-source facets, children, served-by, patches, owner assign. */
export function CIDetail({ id, backTo }: { id: string; backTo: string }) {
  const qc = useQueryClient();
  const q = useQuery(orpc.resources.get.queryOptions({ input: { id }, refetchInterval: 30_000 }));
  const customersQ = useQuery(orpc.customers.list.queryOptions());

  const assign = useMutation({
    mutationFn: (customerId: string | null) =>
      orpcClient.resources.assignOwner({ resourceId: id, customerId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.resources.key() }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Eigentümer konnte nicht gesetzt werden"),
  });
  const setStatus = useMutation({
    mutationFn: (status: "active" | "decommissioned") =>
      orpcClient.resources.setStatus({ resourceIds: [id], status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.resources.key() }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Status konnte nicht geändert werden"),
  });

  if (q.isLoading) {
    return (
      <div>
        <PageHeader title="Configuration Item" />
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div>
        <PageHeader title="Configuration Item" />
        <div className="p-8 text-sm text-muted-foreground">
          {q.isError ? "Dieses Element konnte nicht geladen werden. " : "Nicht gefunden. "}
          <Link to={backTo} className="text-primary hover:underline">
            Zurück
          </Link>
        </div>
      </div>
    );
  }

  const { resource, facets, children, monitor, patches, servedBy, history, parent } = q.data;
  const isHost = resource.type === "host";
  const decommissioned = resource.status === "decommissioned";
  const attributes = Object.entries(resource.metadata as Record<string, unknown>).filter(
    ([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  const ssm = facets.find((f) => f.source === "ssm")?.data as Record<string, unknown> | undefined;
  const status =
    (monitor?.lastStatus as CheckStatus | undefined) ?? pingToStatus(ssm?.pingStatus as string);
  const customers = customersQ.data ?? [];
  const kindLabel = resourceTypeLabel(resource.type);

  return (
    <div>
      <PageHeader
        title={resource.name}
        description={`${kindLabel} · ${resource.externalId}`}
        actions={
          <Link
            to={backTo}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Zurück
          </Link>
        }
      />
      <div className="space-y-6 p-8">
        {/* Status / served-by + owner */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={decommissioned ? "outline" : "muted"}>
              {decommissioned ? "stillgelegt" : "aktiv"}
            </Badge>
            {parent && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                gehört zu{" "}
                <Link
                  to="/ci/$id"
                  params={{ id: parent.id }}
                  className="text-primary hover:underline"
                >
                  {parent.name}
                </Link>
              </span>
            )}
            {isHost && (
              <>
                <StatusDot status={status} />
                <StatusBadge status={status} />
                {monitor && (
                  <span className="text-xs text-muted-foreground">
                    {formatLatency(monitor.lastLatencyMs)} · geprüft{" "}
                    {relativeTime(monitor.lastCheckedAt)}
                  </span>
                )}
              </>
            )}
            {servedBy.length > 0 && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Server className="size-4" />
                bereitgestellt von{" "}
                {servedBy.map((h, i) => (
                  <span key={h.id}>
                    {i > 0 && ", "}
                    <Link
                      to="/ci/$id"
                      params={{ id: h.id }}
                      className="text-primary hover:underline"
                    >
                      {h.name}
                    </Link>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate(decommissioned ? "active" : "decommissioned")}
            >
              {decommissioned ? "Reaktivieren" : "Stilllegen"}
            </Button>
            <span className="text-xs text-muted-foreground">Eigentümer</span>
            <Select
              value={resource.ownerCustomerId ?? NONE}
              onValueChange={(val) => assign.mutate(val === NONE ? null : val)}
            >
              <SelectTrigger className="h-8 w-52">
                <SelectValue placeholder="Nicht zugeordnet" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nicht zugeordnet</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {facets.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {facets.map((f) => (
              <Card key={f.source} className="space-y-2 p-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {FACET_TITLES[f.source] ?? f.source}
                </div>
                <dl className="space-y-1 text-sm">
                  {Object.entries(f.data as Record<string, unknown>)
                    .filter(([, v]) => v != null && v !== "")
                    .map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3">
                        <dt className="shrink-0 text-xs text-muted-foreground">{labelize(k)}</dt>
                        <dd className="min-w-0 truncate text-right font-mono text-xs">
                          {formatVal(k, v)}
                        </dd>
                      </div>
                    ))}
                  {(f.ips as string[]).length > 0 && (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="shrink-0 text-xs text-muted-foreground">IP</dt>
                      <dd className="min-w-0 truncate text-right font-mono text-xs">
                        {(f.ips as string[]).join(", ")}
                      </dd>
                    </div>
                  )}
                </dl>
              </Card>
            ))}
          </div>
        )}

        {children.length > 0 && (
          <ChildrenSection
            isHost={isHost}
            childrenRows={children}
            customers={customers.map((c) => ({ id: c.id, name: c.name }))}
            onChanged={() => qc.invalidateQueries({ queryKey: orpc.resources.key() })}
          />
        )}

        {attributes.length > 0 && facets.length === 0 && (
          <Card className="space-y-2 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Attribute
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {attributes.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-xs text-muted-foreground">{labelize(k)}</dt>
                  <dd
                    className="min-w-0 truncate text-right font-mono text-xs"
                    title={formatVal(k, v)}
                  >
                    {formatVal(k, v)}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        {history.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <History className="size-4" />
              Verlauf ({history.length})
            </div>
            <Card className="divide-y divide-border p-0">
              {history.map((h) => (
                <div key={h.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="w-36 shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(h.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {HISTORY_FIELD[h.field] ?? h.field}:{" "}
                    <span className="text-muted-foreground">{h.oldValue ?? "–"}</span>
                    {" → "}
                    <span className="font-medium">{h.newValue ?? "–"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {actorLabel(h.actor)}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        )}

        {(patches.installed.length > 0 || patches.missing.length > 0) && (
          <div className="grid gap-6 lg:grid-cols-2">
            <PatchList
              icon={<ShieldAlert className="size-3.5" />}
              title="Ausstehende Updates"
              rows={patches.missing.map((p) => ({ title: p.title, right: p.severity ?? "" }))}
              empty="Vollständig gepatcht."
            />
            <PatchList
              icon={<PackageCheck className="size-3.5" />}
              title="Letzte Updates"
              rows={patches.installed.map((p) => ({
                title: p.title,
                right: p.installedAt ? relativeTime(p.installedAt) : "",
              }))}
              empty="Keine Updates aufgezeichnet."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PatchList({
  icon,
  title,
  rows,
  empty,
}: {
  icon: ReactNode;
  title: string;
  rows: { title: string; right: string }[];
  empty: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
        {rows.length > 0 ? ` (${rows.length})` : ""}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {rows.map((r) => (
            <div
              key={r.title}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2.5 py-1.5"
            >
              <span className="min-w-0 truncate font-mono text-xs" title={r.title}>
                {r.title}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{r.right}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface ChildRow {
  id: string;
  name: string;
  ownerCustomerId: string | null;
  metadata: unknown;
}

/** A CI's children (a host's containers, a domain's mailboxes) with each one's
 * owner and a bulk assign bar, so a whole box can be attributed in one go. */
function ChildrenSection({
  isHost,
  childrenRows,
  customers,
  onChanged,
}: {
  isHost: boolean;
  childrenRows: ChildRow[];
  customers: { id: string; name: string }[];
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => childrenRows.map((c) => c.id), [childrenRows]);
  const sel = useSelection(ids);
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const unowned = childrenRows.filter((c) => !c.ownerCustomerId).length;

  async function assign(customerId: string | null) {
    setBusy(true);
    try {
      const resourceIds = [...sel.selected];
      await orpcClient.resources.assignOwners({ resourceIds, customerId });
      toast.success(
        customerId
          ? `${resourceIds.length} an ${customerName.get(customerId) ?? "Kunde"} zugeordnet.`
          : `Zuordnung von ${resourceIds.length} entfernt.`,
      );
      sel.clear();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Boxes className="size-4" />
          {isHost ? "Container" : "Postfächer"} ({childrenRows.length})
        </div>
        {unowned > 0 && <span className="text-xs text-amber-500">{unowned} ohne Eigentümer</span>}
      </div>
      <Card className="divide-y divide-border p-0">
        {childrenRows.map((c) => {
          const selected = sel.selected.has(c.id);
          return (
            <label
              key={c.id}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm ${
                selected ? "bg-primary/5" : "hover:bg-accent/30"
              }`}
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected}
                onChange={() => sel.toggle(c.id)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <span className="hidden max-w-[16rem] shrink-0 truncate text-xs text-muted-foreground md:inline">
                {((c.metadata as Record<string, unknown>)?.image as string) ?? ""}
              </span>
              <span
                className={`w-40 shrink-0 truncate text-right text-xs ${
                  c.ownerCustomerId ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {c.ownerCustomerId
                  ? (customerName.get(c.ownerCustomerId) ?? "zugeordnet")
                  : "nicht zugeordnet"}
              </span>
            </label>
          );
        })}
      </Card>
      <BulkAssignBar
        selectedCount={sel.selected.size}
        visibleCount={childrenRows.length}
        allSelected={sel.allSelected}
        onSelectAll={sel.selectAll}
        onClear={sel.clear}
        customers={customers}
        onAssign={assign}
        allowUnassign
        busy={busy}
        extra={
          unowned > 0 &&
          sel.selected.size === 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                for (const c of childrenRows) if (!c.ownerCustomerId) sel.toggle(c.id);
              }}
            >
              Nur nicht zugeordnete wählen ({unowned})
            </Button>
          )
        }
      />
    </section>
  );
}
