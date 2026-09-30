import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDown, Mailbox, Pencil, Plus, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { CAPABILITY_LIST, CapabilityDots } from "@/components/map/capability-dots";
import type { MapEdge, MapNode } from "@/components/map/infra-map";
import { MailActivityFeed, type MailFeedItem, MailTimeline } from "@/components/map/mail-timeline";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { daysUntil, expiryColor, KIND_LABEL } from "@/lib/customer";
import { formatLatency } from "@/lib/format";
import { FlowController } from "@/lib/mail-flow";
import { orpc, orpcClient } from "@/lib/orpc";

// Leaflet touches window/document, so the map is loaded client-only (see mounted gate).
const InfraMap = lazy(() => import("@/components/map/infra-map"));

export const Route = createFileRoute("/_app/map")({
  component: MapPage,
});

type RelationType = "depends_on" | "feeds" | "connects" | "monitors";

const RELATION_LABELS: Record<RelationType, string> = {
  depends_on: "hängt ab von",
  feeds: "speist",
  connects: "verbindet mit",
  monitors: "überwacht",
};

const STATUS_COLOR: Record<string, string> = {
  up: "#2f6bff",
  down: "#ef4444",
  degraded: "#f59e0b",
  unknown: "#64748b",
};

type DomainPane = {
  name: string;
  customerId: string | null;
  hasDns: boolean;
  recordCount: number | null;
  dnssecEnabled: boolean | null;
  hasRegistry: boolean;
  registrar: string | null;
  registryExpiresAt: string | Date | null;
  autoRenew: boolean | null;
  transferLock: boolean | null;
  hasWeb: boolean;
  webBehavior: string | null;
  hasSesMail: boolean;
  hasMailcowMail: boolean;
  certExpiresAt: string | Date | null;
};

function MapPage() {
  const queryClient = useQueryClient();
  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [feed, setFeed] = useState<MailFeedItem[]>([]);
  useEffect(() => setMounted(true), []);

  // One long-lived controller drives the map particles for the page's lifetime.
  const controllerRef = useRef<FlowController | null>(null);
  if (!controllerRef.current) controllerRef.current = new FlowController();
  const controller = controllerRef.current;

  // Live tail: poll newly-ingested mail events, feed them to the particle stream
  // (ignored while replaying) and the activity list. serverTime is the cursor.
  useEffect(() => {
    if (!mounted) return;
    controller.setLive();
    let cancelled = false;
    let since = new Date(Date.now() - 30_000).toISOString();
    async function tick() {
      try {
        const res = await orpcClient.mail.events.recent({ since });
        if (cancelled) return;
        since = new Date(res.serverTime).toISOString();
        if (res.events.length === 0) return;
        controller.ingestLive(res.events);
        setFeed((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const next = res.events
            .filter((e) => !seen.has(e.id))
            .map((e) => ({
              id: e.id,
              direction: e.direction,
              domain: e.domain,
              counterparty: e.counterparty,
              occurredAt: e.occurredAt,
            }))
            .reverse();
          return [...next, ...prev].slice(0, 40);
        });
      } catch {
        // Transient poll failures are non-fatal; the next tick retries.
      }
    }
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mounted, controller]);

  const mapQuery = useQuery(orpc.dashboard.map.queryOptions({ refetchInterval: 15_000 }));
  const data = mapQuery.data;
  const nodes = (data?.nodes ?? []) as MapNode[];
  const edges = (data?.edges ?? []) as MapEdge[];
  const unplaced = data?.unplacedAssets ?? [];

  const domainsQuery = useQuery(orpc.domains.list.queryOptions({ refetchInterval: 30_000 }));
  const allDomains = (domainsQuery.data ?? []) as DomainPane[];

  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const selectedDomains = selected ? allDomains.filter((d) => d.customerId === selected.id) : [];

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: orpc.dashboard.map.key() });
  }

  return (
    <div className="map-shell flex h-[calc(100vh-3.5rem)]">
      <div className="relative min-w-0 flex-1">
        {mounted ? (
          <Suspense fallback={<MapPlaceholder />}>
            <div className="absolute inset-0">
              <InfraMap
                nodes={nodes}
                edges={edges}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onSelect={setSelectedId}
                onHover={setHoveredId}
                flowController={controller}
              />
            </div>
          </Suspense>
        ) : (
          <MapPlaceholder />
        )}
        <div className="map-vignette" />
        {nodes.length > 0 && <MapLegend />}
        {nodes.length > 0 && <MailTimeline controller={controller} />}
        {mapQuery.isError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto rounded-lg border border-border bg-card/90 px-5 py-4 text-center text-sm text-red-500">
              Die Karte konnte nicht geladen werden. Es wird automatisch erneut versucht.
            </div>
          </div>
        ) : (
          nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="pointer-events-auto rounded-lg border border-border bg-card/90 px-5 py-4 text-center text-sm">
                Noch keine Kunden auf der Karte.{" "}
                <Link to="/customers" className="text-primary hover:underline">
                  Ersten Kunden anlegen
                </Link>
                .
              </div>
            </div>
          )
        )}
      </div>

      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card/40">
        <div className="border-b border-border px-5 py-4">
          <h1 className="text-base font-semibold tracking-tight">Infrastrukturkarte</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {nodes.length} {nodes.length === 1 ? "Kunde" : "Kunden"}, {edges.length}{" "}
            {edges.length === 1 ? "Verbindung" : "Verbindungen"}
          </p>
        </div>

        <div className="flex-1 space-y-5 p-4">
          {selected ? (
            <CustomerFlyout
              node={selected}
              domains={selectedDomains}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <ConnectionsManager
              nodes={nodes}
              edges={edges.filter((e) => !e.derived)}
              nameById={nameById}
              onChange={invalidate}
            />
          )}

          <MailActivityFeed items={feed} />

          {unplaced.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Prüfungen ohne Standort ({unplaced.length})
              </div>
              <p className="text-xs text-muted-foreground">
                Diese haben keinen Standort.{" "}
                <Link to="/customers" className="text-primary hover:underline">
                  Einem Kunden zuordnen
                </Link>
                , damit sie auf der Karte erscheinen.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function MapPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#07101e]">
      <p className="text-sm text-muted-foreground">Lade Karte…</p>
    </div>
  );
}

const LEGEND_STATUS: { label: string; color: string }[] = [
  { label: "Online", color: "#2f6bff" },
  { label: "Eingeschränkt", color: "#f59e0b" },
  { label: "Ausfall", color: "#ef4444" },
  { label: "Unbekannt", color: "#64748b" },
  { label: "Mailverkehr", color: "#14b8c4" },
];

function MapLegend() {
  const [open, setOpen] = useState(true);
  return (
    <div className="map-legend">
      <button
        type="button"
        className="map-legend-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Legende</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="map-legend-body">
          <div className="map-legend-title">Status</div>
          {LEGEND_STATUS.map((s) => (
            <div key={s.label} className="map-legend-row">
              <span className="map-legend-dot" style={{ backgroundColor: s.color }} />
              {s.label}
            </div>
          ))}
          <div className="map-legend-title">Dienste</div>
          {CAPABILITY_LIST.map(({ key, title, Icon, color }) => (
            <div key={key} className="map-legend-row">
              <Icon className="map-legend-glyph" style={{ color }} />
              {title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerFlyout({
  node,
  domains,
  onClose,
}: {
  node: MapNode;
  domains: DomainPane[];
  onClose: () => void;
}) {
  const hasCaps =
    node.capabilities.hasDns ||
    node.capabilities.hasMail ||
    node.capabilities.hasWeb ||
    node.capabilities.hasRegistry ||
    node.capabilities.hasCloudfront;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="size-3 shrink-0 rounded-full"
            style={{
              backgroundColor: STATUS_COLOR[node.status] ?? "#64748b",
              boxShadow: `0 0 8px ${STATUS_COLOR[node.status] ?? "#64748b"}`,
            }}
          />
          <div className="font-medium leading-tight">{node.name}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Schließen"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex items-center justify-between text-sm">
        <StatusBadge status={node.status} />
        <span className="text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</span>
      </div>
      {hasCaps && (
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">Betreibt</span>
          <CapabilityDots capabilities={node.capabilities} size={15} />
        </div>
      )}
      {node.address && <div className="text-xs text-muted-foreground">{node.address}</div>}

      <div className="space-y-1">
        {node.assets.length === 0 ? (
          <p className="text-xs text-muted-foreground">Noch keine Prüfungen zugeordnet.</p>
        ) : (
          node.assets.map((a) => {
            return (
              <Link
                key={a.id}
                to="/assets/$assetId"
                params={{ assetId: a.id }}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <StatusDot status={a.lastStatus} />
                <ConnectorGlyph
                  connectorId={a.connectorId}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatLatency(a.lastLatencyMs)}
                </span>
              </Link>
            );
          })
        )}
      </div>

      {domains.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wide text-muted-foreground">
              Domains
            </span>
            {node.mailboxCount > 0 && (
              <span className="text-muted-foreground">{node.mailboxCount} Postfächer</span>
            )}
          </div>
          {domains.map((d) => {
            const days = daysUntil(d.registryExpiresAt);
            return (
              <div key={d.name} className="space-y-1 rounded-md border border-border px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{d.name}</span>
                  <CapabilityDots
                    capabilities={{
                      hasDns: d.hasDns,
                      hasMail: d.hasSesMail || d.hasMailcowMail,
                      hasWeb: d.hasWeb,
                      hasRegistry: d.hasRegistry,
                      // A web_distribution row is a CloudFront distribution.
                      hasCloudfront: d.hasWeb,
                      registryExpiresAt: d.registryExpiresAt,
                    }}
                    size={12}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {d.hasDns && (
                    <span>
                      DNS{d.recordCount != null ? ` · ${d.recordCount} Einträge` : ""}
                      {d.dnssecEnabled ? " · DNSSEC" : ""}
                    </span>
                  )}
                  {d.hasWeb && (
                    <span style={{ color: "#34d399" }}>
                      CloudFront{d.webBehavior === "redirect" ? " · Weiterleitung" : ""}
                    </span>
                  )}
                  {d.certExpiresAt &&
                    (() => {
                      const certDays = daysUntil(d.certExpiresAt);
                      return (
                        <span style={{ color: expiryColor(certDays) }}>
                          TLS{" "}
                          {certDays !== null && certDays < 0 ? "abgelaufen" : `in ${certDays} d`}
                        </span>
                      );
                    })()}
                  {d.hasRegistry && days !== null && (
                    <span style={{ color: expiryColor(days) }}>
                      Läuft {days < 0 ? "ab: überfällig" : `ab in ${days} d`}
                      {d.autoRenew === false ? " · keine Auto-Verlängerung" : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm" className="flex-1">
          <Link to="/customers">
            <Pencil className="size-4" />
            Kunden
          </Link>
        </Button>
        {node.domainCount > 0 && (
          <Button asChild variant="outline" size="sm" className="flex-1">
            <Link to="/domains">
              <Mailbox className="size-4" />
              Domains
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function ConnectionsManager({
  nodes,
  edges,
  nameById,
  onChange,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  nameById: Map<string, string>;
  onChange: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState("");
  const [type, setType] = useState<RelationType>("connects");
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFrom("");
    setType("connects");
    setTargets(new Set());
    setError(null);
  }

  function toggleTarget(id: string) {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConnect() {
    if (!from || targets.size === 0) return;
    setError(null);
    setBusy(true);
    try {
      await orpcClient.relations.createMany({
        fromCustomerId: from,
        toLocationIds: [...targets],
        type,
      });
      setAdding(false);
      reset();
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verbinden fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    await orpcClient.relations.remove({ id });
    await onChange();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Verbindungen
        </div>
        {!adding && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            disabled={nodes.length < 2}
          >
            <Plus className="size-4" />
            Hinzufügen
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <Select
            value={from}
            onValueChange={(v) => {
              setFrom(v);
              setTargets((prev) => {
                const next = new Set(prev);
                next.delete(v);
                return next;
              });
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Von Kunde" />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={type} onValueChange={(v) => setType(v as RelationType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RELATION_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Nach (einen oder mehrere wählen)
          </div>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-1">
            {nodes
              .filter((n) => n.id !== from)
              .map((n) => (
                <label
                  key={n.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={targets.has(n.id)}
                    onChange={() => toggleTarget(n.id)}
                  />
                  <span className="min-w-0 truncate">{n.name}</span>
                </label>
              ))}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={busy || !from || targets.size === 0}
            >
              {busy ? "Verbinde…" : `Verbinden ${targets.size || ""}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
                reset();
              }}
            >
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {edges.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">
          Noch keine Verbindungen. Verknüpfe einen Kunden mit anderen, um Datenflüsse zu zeichnen.
        </p>
      )}

      <div className="space-y-1">
        {edges.map((e) => (
          <div
            key={e.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {nameById.get(e.fromCustomerId) ?? "?"}{" "}
              <span className="text-muted-foreground">
                {RELATION_LABELS[e.type as RelationType] ?? e.type}
              </span>{" "}
              {nameById.get(e.toCustomerId) ?? "?"}
            </span>
            <button
              type="button"
              onClick={() => handleRemove(e.id)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
              aria-label="Verbindung entfernen"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
