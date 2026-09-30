import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AllocationEntry,
  type AllocationResource,
  type AllocationRowView,
  groupAllocations,
  type RowMode,
} from "@/lib/cost-allocation-groups";
import {
  centsToInput,
  formatEuro,
  formatPeriod,
  parseEuroToCents,
  resourceTypeLabel,
} from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";
import { periodScopedKey } from "@/lib/period-scope";

export const Route = createFileRoute("/_app/costs")({
  component: CostsPage,
});

const PROVIDERS = ["aws", "hetzner", "railway", "mailcow", "other"] as const;
const PROVIDER_LABEL: Record<string, string> = {
  aws: "AWS",
  hetzner: "Hetzner",
  railway: "Railway",
  mailcow: "Mailcow",
  other: "Sonstige",
};
const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

interface Pool {
  id: string;
  provider: string;
  label: string;
  displayLabel: string;
  amountCents: number;
  allocationCount: number;
  group: "dns" | null;
  managed: boolean;
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const fmt = formatEuro;
const toCents = parseEuroToCents;

function CostsPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const qc = useQueryClient();

  const summaryQuery = useQuery(orpc.costs.summary.queryOptions({ input: { period } }));
  const poolsQuery = useQuery(orpc.costs.pools.list.queryOptions({ input: { period } }));
  const allocQuery = useQuery(orpc.costs.allocations.list.queryOptions({ input: { period } }));
  const resourcesQuery = useQuery(orpc.resources.list.queryOptions({ input: {} }));

  const summary = summaryQuery.data;
  const poolTotalCents = (poolsQuery.data ?? []).reduce((sum, p) => sum + p.amountCents, 0);
  const overheadCents = summary?.unallocatedCostCents ?? 0;
  const customerCents = (summary?.totalCostCents ?? 0) - overheadCents;
  // Money that no allocation accounts for (or accounts for twice). Zero whenever
  // every pool's weights sum to one; the rollup rounds per pool so it stays exact.
  const gapCents = poolTotalCents - (summary?.totalCostCents ?? 0);

  async function invalidate() {
    await Promise.all([qc.invalidateQueries({ queryKey: orpc.costs.key() })]);
  }

  return (
    <div>
      <PageHeader
        title="Kosten"
        description="Was du den Anbietern zahlst und wie sich diese Beträge auf die Ressourcen verteilen. Was daraus je Kunde wird, steht in der Abrechnung."
        actions={
          <>
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-40"
            />
            <Link
              to="/billing"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Zur Abrechnung
            </Link>
          </>
        }
      />

      <div className="space-y-8 p-8">
        {/* Totals */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Totals
            label="Anbieterkosten"
            cents={poolTotalCents}
            hint="Was du in diesem Monat an alle Anbieter zahlst."
          />
          <Totals
            label="Kunden zugerechnet"
            cents={customerCents}
            hint="Landet über die Objekte bei Kunden und steht in der Abrechnung."
          />
          <Totals
            label="Eigenaufwand"
            cents={overheadCents}
            hint="Objekte ohne Kunden, interne Objekte und Pools, die keinem Objekt zugeordnet sind."
            muted
          />
        </div>
        {summary && gapCents !== 0 && (
          <p className="text-xs text-status-degraded">
            {gapCents > 0
              ? `${formatEuro(gapCents)} der Anbieterkosten sind nicht verteilt`
              : `Es sind ${formatEuro(-gapCents)} mehr verteilt, als die Anbieter berechnen`}
            . Ursache sind feste Beträge oder Gewichte eines Pools, die nicht 100 % ergeben; prüfe
            die manuell verteilten Objekte unten.
          </p>
        )}

        {/* Provider cost pools */}
        <ProviderCostPools period={period} pools={poolsQuery.data ?? []} onChange={invalidate} />

        {/* Allocations */}
        <Allocations
          period={period}
          resources={resourcesQuery.data ?? []}
          allocations={allocQuery.data ?? []}
          pools={poolsQuery.data ?? []}
          onChange={invalidate}
        />
      </div>
    </div>
  );
}

function Totals({
  label,
  cents,
  hint,
  muted,
}: {
  label: string;
  cents: number;
  hint: string;
  muted?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${muted ? "text-muted-foreground" : ""}`}
      >
        {fmt(cents)}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </Card>
  );
}

function ProviderCostPools({
  period,
  pools,
  onChange,
}: {
  period: string;
  pools: Pool[];
  onChange: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<string>("hetzner");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const amountCents = toCents(amount);
    if (!label.trim() || amountCents == null) return;
    setBusy(true);
    try {
      await orpcClient.costs.pools.upsert({
        provider: provider as (typeof PROVIDERS)[number],
        period,
        label: label.trim(),
        amountCents,
      });
      setLabel("");
      setAmount("");
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kosten konnten nicht hinzugefügt werden");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await orpcClient.costs.pools.remove({ id });
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kosten konnten nicht gelöscht werden");
    }
  }

  const byProvider = new Map<string, Pool[]>();
  for (const p of pools) {
    const list = byProvider.get(p.provider);
    if (list) list.push(p);
    else byProvider.set(p.provider, [p]);
  }
  const providers = [...byProvider.keys()].sort(
    (a, b) => PROVIDERS.indexOf(a as never) - PROVIDERS.indexOf(b as never),
  );

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Anbieterkosten ({formatPeriod(period)})</h2>
      <p className="text-xs text-muted-foreground">
        Was du diesen Monat an jeden Anbieter zahlst. Abgeglichene Pools kommen automatisch aus den
        Anbieterkonten und werden auf Objekte verteilt; eigene Pools legst du unten an.
      </p>
      <Card className="divide-y divide-border p-0">
        {pools.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">Noch keine Anbieterkosten.</div>
        ) : (
          providers.map((prov) => {
            const list = byProvider.get(prov)!;
            const dns = list.filter((p) => p.group === "dns");
            const rest = list.filter((p) => p.group !== "dns");
            return (
              <div key={prov} className="p-2">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <ConnectorGlyph connectorId={prov} className="size-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{providerLabel(prov)}</span>
                  <span className="text-sm font-medium tabular-nums">
                    {fmt(list.reduce((s, p) => s + p.amountCents, 0))}
                  </span>
                  <span className="w-9" />
                </div>
                {rest.map((p) => (
                  <PoolRow key={p.id} pool={p} onRemove={remove} />
                ))}
                {dns.length > 0 && <DnsGroup pools={dns} />}
              </div>
            );
          })
        )}
        <div className="flex items-center gap-2 p-3">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {providerLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Bezeichnung (z. B. Server web.example.test)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="€ / Monat"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-28"
            inputMode="decimal"
          />
          <Button disabled={busy} onClick={add}>
            <Plus className="size-4" />
            Hinzufügen
          </Button>
        </div>
      </Card>
    </section>
  );
}

function allocationHint(count: number): string {
  if (count === 0) return "keinem Objekt zugeordnet, zählt als Eigenaufwand";
  return count === 1 ? "auf 1 Objekt" : `auf ${count} Objekte verteilt`;
}

function PoolRow({
  pool,
  onRemove,
  indent,
}: {
  pool: Pool;
  onRemove?: (id: string) => void;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm hover:bg-accent ${indent ? "pl-12" : "pl-8"}`}
    >
      <span className="min-w-0 flex-1 truncate">{pool.displayLabel}</span>
      <span
        className={`hidden shrink-0 text-xs sm:inline ${pool.allocationCount === 0 ? "text-status-degraded" : "text-muted-foreground"}`}
      >
        {pool.managed ? "" : "manuell · "}
        {allocationHint(pool.allocationCount)}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
        {fmt(pool.amountCents)}
      </span>
      {onRemove && !pool.managed ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRemove(pool.id)}
          aria-label="Kosten löschen"
        >
          <Trash2 className="size-4" />
        </Button>
      ) : (
        <span className="w-9 shrink-0" />
      )}
    </div>
  );
}

function DnsGroup({ pools }: { pools: Pool[] }) {
  const [open, setOpen] = useState(false);
  const total = pools.reduce((s, p) => s + p.amountCents, 0);
  const unassigned = pools.filter((p) => p.allocationCount === 0).length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-sm hover:bg-accent"
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate">
          Route 53 · {pools.length} {pools.length === 1 ? "Zone" : "Zonen"}
        </span>
        <span
          className={`hidden shrink-0 text-xs sm:inline ${unassigned > 0 ? "text-status-degraded" : "text-muted-foreground"}`}
        >
          {unassigned > 0 ? `${unassigned} ohne Zuordnung` : "je Zone auf ihre Domain"}
        </span>
        <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
          {fmt(total)}
        </span>
        <span className="w-9 shrink-0" />
      </button>
      {open && pools.map((p) => <PoolRow key={p.id} pool={p} indent />)}
    </div>
  );
}

function Allocations({
  period,
  resources,
  allocations,
  pools,
  onChange,
}: {
  period: string;
  resources: AllocationResource[];
  allocations: AllocationEntry[];
  pools: Pool[];
  onChange: () => Promise<void>;
}) {
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();
  const filtering = q !== "" || providerFilter !== "all" || ownerFilter !== "all";
  const shown = resources.filter(
    (r) =>
      (providerFilter === "all" || r.provider === providerFilter) &&
      (ownerFilter === "all" ||
        (ownerFilter === "unassigned" ? !r.ownerName : r.ownerName === ownerFilter)) &&
      (!q || r.name.toLowerCase().includes(q) || (r.ownerName ?? "").toLowerCase().includes(q)),
  );
  const owners = [...new Set(resources.map((r) => r.ownerName).filter(Boolean))].sort() as string[];
  // A zone and a Railway project can share a name (untereuerheim.com); say which
  // one a DNS group is.
  const groupPools = pools.map((p) =>
    p.group === "dns" ? { ...p, displayLabel: `Route 53 · ${p.displayLabel}` } : p,
  );
  const groups = groupAllocations({ resources: shown, allocations, pools: groupPools });
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Kostenverteilung ({formatPeriod(period)})</h2>
      <p className="text-xs text-muted-foreground">
        Welches Objekt wie viel aus welchem Pool trägt. Automatisch heißt: Container nach RAM,
        Postfächer gleichmäßig über den Mailserver, eine Domain trägt ihre DNS-Kosten, alles andere
        gleichmäßig über den Pool seines Anbieters. Ein fester Betrag, ein eigenes Gewicht oder
        „Keine Kosten“ überschreibt das für dieses Objekt.
      </p>
      <ListToolbar search={search} onSearch={setSearch} placeholder="Objekt oder Kunde suchen">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Anbieter</SelectItem>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Kunden</SelectItem>
            <SelectItem value="unassigned">Ohne Kunde</SelectItem>
            {owners.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ListToolbar>
      <Card className="divide-y divide-border p-0">
        {groups.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">
            {resources.length === 0 ? "Noch keine Objekte." : "Kein Objekt passt zum Filter."}
          </div>
        ) : (
          groups.map((g) => {
            // While filtering, show the matches without an extra click.
            const open = filtering || openKeys.has(g.key);
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <ChevronRight
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                  />
                  {g.pool && (
                    <ConnectorGlyph
                      connectorId={g.pool.provider}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{g.title}</span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {g.rows.length === 1 ? "1 Objekt" : `${g.rows.length} Objekte`}
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums">
                    {g.key === "none" ? "" : fmt(g.cents)}
                  </span>
                </button>
                {open && (
                  <div className="pb-2">
                    {g.rows.map((row) => (
                      <AllocationRow
                        key={periodScopedKey(period, row.resource.id)}
                        period={period}
                        row={row}
                        pools={pools}
                        onChange={onChange}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>
    </section>
  );
}

const MODE_LABEL: Record<RowMode, string> = {
  auto: "Automatisch",
  fixed: "Fester Betrag",
  weighted: "Eigenes Gewicht",
  zero: "Keine Kosten",
};

function AllocationRow({
  period,
  row,
  pools,
  onChange,
}: {
  period: string;
  row: AllocationRowView;
  pools: Pool[];
  onChange: () => Promise<void>;
}) {
  const { resource, alloc, mode } = row;
  const [busy, setBusy] = useState(false);
  const [fixed, setFixed] = useState(
    alloc?.amountCents != null && alloc.amountCents > 0 ? centsToInput(alloc.amountCents) : "",
  );
  const [weight, setWeight] = useState(alloc?.weight != null ? String(alloc.weight) : "1");

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verteilung konnte nicht aktualisiert werden");
    } finally {
      setBusy(false);
    }
  }

  const upsertFixed = (amountCents: number) =>
    orpcClient.costs.allocations.upsert({
      resourceId: resource.id,
      period,
      mode: "fixed",
      amountCents,
    });
  const upsertWeighted = (providerCostId: string, w: string) =>
    orpcClient.costs.allocations.upsert({
      resourceId: resource.id,
      period,
      mode: "weighted",
      weight: Number.parseFloat(w.replace(",", ".")) || 0,
      providerCostId,
    });
  // Start a hand weight on the pool the resource already draws from.
  const currentPoolId = alloc?.providerCostId ?? pools[0]?.id ?? "";

  function setMode(next: string) {
    if (next === mode) return;
    if (next === "auto") {
      if (alloc && !alloc.auto)
        void run(() => orpcClient.costs.allocations.remove({ id: alloc.id }));
    } else if (next === "zero") {
      void run(() => upsertFixed(0));
    } else if (next === "fixed") {
      void run(() => upsertFixed(toCents(fixed) ?? row.cents));
    } else if (next === "weighted" && currentPoolId) {
      void run(() => upsertWeighted(currentPoolId, weight));
    }
  }

  return (
    <div className="flex items-center gap-2 py-1 pl-10 pr-3 text-sm hover:bg-accent">
      <ConnectorGlyph
        connectorId={resource.provider}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate" title={resource.name}>
        {resource.name}
        <span className="ml-2 text-xs text-muted-foreground">
          {resourceTypeLabel(resource.type)}
        </span>
      </span>
      <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground md:block">
        {resource.ownerName ?? "ohne Kunde"}
      </span>
      {mode === "fixed" && (
        <Input
          value={fixed}
          disabled={busy}
          onChange={(e) => setFixed(e.target.value)}
          onBlur={() => {
            const c = toCents(fixed);
            if (c != null && c !== alloc?.amountCents) void run(() => upsertFixed(c));
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="€ / Monat"
          className="h-8 w-24 text-right tabular-nums"
          inputMode="decimal"
        />
      )}
      {mode === "weighted" && (
        <>
          <Input
            value={weight}
            disabled={busy}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={() => void run(() => upsertWeighted(currentPoolId, weight))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="Gewicht"
            className="h-8 w-20 text-right tabular-nums"
            inputMode="decimal"
            title="Anteil am Pool, 1 = 100 %"
          />
          <Select
            value={currentPoolId}
            onValueChange={(pid) => void run(() => upsertWeighted(pid, weight))}
            disabled={busy || pools.length === 0}
          >
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="Pool" />
            </SelectTrigger>
            <SelectContent>
              {pools.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.displayLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <Select value={mode} onValueChange={setMode} disabled={busy}>
        <SelectTrigger className="h-8 w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(MODE_LABEL) as RowMode[]).map((m) => (
            <SelectItem key={m} value={m}>
              {MODE_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
        {row.cents > 0 ? fmt(row.cents) : "–"}
      </span>
    </div>
  );
}
