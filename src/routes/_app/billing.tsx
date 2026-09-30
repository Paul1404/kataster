import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  ReceiptEuro,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { BulkAssignBar } from "@/components/bulk-assign-bar";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { INTERVAL_LABEL } from "@/components/customers/contract-positions";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { KIND_LABEL } from "@/lib/customer";
import { formatEuro, formatPeriod, parseEuroToCents, resourceTypeLabel } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";
import { periodScopedKey } from "@/lib/period-scope";
import { useSelection } from "@/lib/use-selection";
import { cn } from "@/lib/utils";
import type {
  BillingReadiness as Readiness,
  CustomerStatement as Statement,
} from "@/server/costs/billing";

export const Route = createFileRoute("/_app/billing")({
  component: BillingPage,
});

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const REASON_LABEL: Record<string, string> = {
  parent: "übergeordnete Ressource",
  name: "Namensähnlichkeit",
};
function reasonLabel(reason: string): string {
  if (reason.startsWith("domain:")) return `Domain ${reason.slice(7)}`;
  return REASON_LABEL[reason] ?? reason;
}

function BillingPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const qc = useQueryClient();

  const readinessQuery = useQuery(orpc.billing.readiness.queryOptions({ input: { period } }));
  const statementsQuery = useQuery(orpc.billing.statements.queryOptions({ input: { period } }));
  const customersQuery = useQuery(orpc.customers.list.queryOptions());

  const readiness = readinessQuery.data;
  const statements = statementsQuery.data?.statements ?? [];
  const customers = (customersQuery.data ?? []).map((c) => ({ id: c.id, name: c.name }));

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: orpc.billing.key() }),
      qc.invalidateQueries({ queryKey: orpc.costs.key() }),
      qc.invalidateQueries({ queryKey: orpc.resources.key() }),
      qc.invalidateQueries({ queryKey: orpc.customers.key() }),
    ]);
  }

  function exportCsv() {
    const rows: string[][] = [
      [
        "Zeitraum",
        "Kunde",
        "Art",
        "Ressource",
        "Typ",
        "Anbieter",
        "Kosten (EUR)",
        "Preis (EUR)",
        "Marge (EUR)",
      ],
    ];
    for (const s of statements) {
      rows.push([
        period,
        s.name,
        KIND_LABEL[s.kind as keyof typeof KIND_LABEL] ?? s.kind,
        "",
        "",
        "",
        (s.costCents / 100).toFixed(2),
        (s.chargeCents / 100).toFixed(2),
        (s.marginCents / 100).toFixed(2),
      ]);
      for (const l of s.lines) {
        rows.push([
          period,
          s.name,
          "",
          l.name,
          resourceTypeLabel(l.type),
          l.provider,
          (l.costCents / 100).toFixed(2),
          "",
          "",
        ]);
      }
    }
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(";"))
      .join("\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `abrechnung-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Abrechnung"
        description="Was jedem Mandanten in Rechnung gestellt werden kann: offene Zuordnungen, Preise und die Kostenaufstellung je Kunde."
        actions={
          <>
            <Input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-40"
            />
            <Button variant="outline" onClick={exportCsv} disabled={statements.length === 0}>
              <Download className="size-4" />
              CSV
            </Button>
          </>
        }
      />

      <div className="space-y-8 p-8">
        {readiness && <ReadinessBanner readiness={readiness} />}

        <UnassignedSection
          period={period}
          readiness={readiness ?? null}
          loading={readinessQuery.isLoading}
          customers={customers}
          onChange={invalidate}
        />

        <PricesSection period={period} readiness={readiness ?? null} onChange={invalidate} />

        <StatementsSection
          period={period}
          statements={statements}
          loading={statementsQuery.isLoading}
          error={statementsQuery.isError}
        />
      </div>
    </div>
  );
}

function ReadinessBanner({ readiness }: { readiness: Readiness }) {
  const costly = readiness.unassigned.filter((r) => r.costCents > 0).length;
  const issues: string[] = [];
  if (costly > 0) {
    issues.push(
      `${costly} nicht zugeordnete ${costly === 1 ? "Ressource verursacht" : "Ressourcen verursachen"} ${formatEuro(readiness.unassignedCostCents)} Kosten`,
    );
  }
  if (readiness.unpriced.length > 0) {
    issues.push(
      `${readiness.unpriced.length} ${readiness.unpriced.length === 1 ? "Kunde hat" : "Kunden haben"} keine Vertragsposition`,
    );
  }
  if (readiness.uncoveredPools.length > 0) {
    issues.push(
      `${readiness.uncoveredPools.length} ${readiness.uncoveredPools.length === 1 ? "Kostenpool wird" : "Kostenpools werden"} nicht verteilt`,
    );
  }

  if (readiness.ready && issues.length === 0) {
    return (
      <Card className="flex items-center gap-3 border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
        <Check className="size-4 shrink-0 text-emerald-500" />
        <div>
          <span className="font-medium">
            Abrechnung für {formatPeriod(readiness.period)} bereit.
          </span>{" "}
          <span className="text-muted-foreground">
            Alle kostenrelevanten Ressourcen sind zugeordnet und jeder Kunde mit Kosten hat
            Vertragspositionen.
          </span>
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>
        <div className="font-medium">
          Abrechnung für {formatPeriod(readiness.period)} noch nicht vollständig.
        </div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function UnassignedSection({
  period,
  readiness,
  loading,
  customers,
  onChange,
}: {
  period: string;
  readiness: Readiness | null;
  loading: boolean;
  customers: { id: string; name: string }[];
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [onlyCostly, setOnlyCostly] = useState(false);
  const unassigned = readiness?.unassigned ?? [];

  const types = useMemo(() => [...new Set(unassigned.map((r) => r.type))].sort(), [unassigned]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return unassigned.filter(
      (r) =>
        (typeFilter === "all" || r.type === typeFilter) &&
        (!onlyCostly || r.costCents > 0) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          (r.parentName ?? "").toLowerCase().includes(q) ||
          (r.suggestion?.customerName ?? "").toLowerCase().includes(q)),
    );
  }, [unassigned, search, typeFilter, onlyCostly]);
  const shownIds = useMemo(() => shown.map((r) => r.id), [shown]);
  const sel = useSelection(shownIds);

  const highCount = unassigned.filter((r) => r.suggestion?.confidence === "high").length;
  const suggestedCount = unassigned.filter((r) => r.suggestion).length;
  const selectedWithSuggestion = shown.filter((r) => sel.selected.has(r.id) && r.suggestion).length;

  async function run(label: string, fn: () => Promise<number>) {
    setBusy(true);
    try {
      const n = await fn();
      toast.success(n === 1 ? `1 Ressource ${label}.` : `${n} Ressourcen ${label}.`);
      sel.clear();
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  const applyAll = (minConfidence: "high" | "medium") =>
    run("zugeordnet", async () => {
      const { applied } = await orpcClient.billing.applySuggestions({ minConfidence });
      return applied.length;
    });
  const applySelected = () =>
    run("zugeordnet", async () => {
      const { applied } = await orpcClient.billing.applySuggestions({
        resourceIds: [...sel.selected],
      });
      return applied.length;
    });
  const assignSelected = (customerId: string | null) =>
    run("zugeordnet", async () => {
      const resourceIds = [...sel.selected];
      await orpcClient.resources.assignOwners({ resourceIds, customerId });
      return resourceIds.length;
    });

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">
            Nicht zugeordnete Ressourcen ({unassigned.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Kosten dieser Ressourcen landen im Eigenaufwand statt beim Kunden. Sichere Vorschläge
            (Domain oder übergeordnete Ressource bereits zugeordnet) übernimmt der Worker
            automatisch. Alles andere wählst du hier aus und ordnest es in einem Schritt zu.
          </p>
        </div>
        {suggestedCount > 0 && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || highCount === 0}
              onClick={() => applyAll("high")}
            >
              <Wand2 className="size-4" />
              Sichere Vorschläge übernehmen ({highCount})
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => applyAll("medium")}>
              <Sparkles className="size-4" />
              Alle Vorschläge übernehmen ({suggestedCount})
            </Button>
          </div>
        )}
      </div>

      {unassigned.length > 0 && (
        <ListToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Name, Host oder Vorschlag suchen"
        >
          <Select value={typeFilter} onValueChange={setTypeFilter}>
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch id="only-costly" checked={onlyCostly} onCheckedChange={setOnlyCostly} />
            <label htmlFor="only-costly">Nur mit Kosten</label>
          </div>
        </ListToolbar>
      )}

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Lade Ressourcen…</div>
        ) : unassigned.length === 0 ? (
          <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
            <Check className="size-4 text-emerald-500" />
            Jede Ressource hat einen Eigentümer.
          </div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Keine Ressource passt zum Filter.
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
                  <th className="px-4 py-2 text-left font-medium">Ressource</th>
                  <th className="px-4 py-2 text-left font-medium">Typ</th>
                  <th className="px-4 py-2 text-left font-medium">Gehört zu</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Kosten {formatPeriod(period)}
                  </th>
                  <th className="px-4 py-2 text-left font-medium">Vorschlag</th>
                  <th className="px-4 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <UnassignedRow
                    key={periodScopedKey(period, r.id)}
                    resource={r}
                    selected={sel.selected.has(r.id)}
                    onToggle={() => sel.toggle(r.id)}
                    onChange={onChange}
                  />
                ))}
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
          onAssign={assignSelected}
          busy={busy}
          extra={
            selectedWithSuggestion > 0 && (
              <Button size="sm" variant="outline" disabled={busy} onClick={applySelected}>
                <Wand2 className="size-4" />
                Vorschläge der Auswahl übernehmen ({selectedWithSuggestion})
              </Button>
            )
          }
        />
      )}
    </section>
  );
}

function UnassignedRow({
  resource: r,
  selected,
  onToggle,
  onChange,
}: {
  resource: Readiness["unassigned"][number];
  selected: boolean;
  onToggle: () => void;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function acceptSuggestion() {
    if (!r.suggestion) return;
    setBusy(true);
    try {
      await orpcClient.resources.assignOwner({
        resourceId: r.id,
        customerId: r.suggestion.customerId,
      });
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr
      className={cn(
        "border-b border-border/50 last:border-0",
        selected ? "bg-primary/5" : "hover:bg-accent/30",
      )}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={selected}
          onChange={onToggle}
          aria-label={`${r.name} wählen`}
        />
      </td>
      <td className="max-w-[18rem] px-4 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2 text-left"
        >
          <ConnectorGlyph
            connectorId={r.provider}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate" title={r.name}>
            {r.name}
          </span>
        </button>
      </td>
      <td className="px-4 py-2 text-xs text-muted-foreground">{resourceTypeLabel(r.type)}</td>
      <td className="max-w-[12rem] truncate px-4 py-2 text-xs text-muted-foreground">
        {r.parentName ?? ""}
      </td>
      <td
        className={cn(
          "px-4 py-2 text-right tabular-nums",
          r.costCents > 0 ? "text-amber-500" : "text-muted-foreground",
        )}
      >
        {r.costCents > 0 ? formatEuro(r.costCents) : "keine"}
      </td>
      <td className="px-4 py-2">
        {r.suggestion ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm">{r.suggestion.customerName}</span>
            <Badge variant={r.suggestion.confidence === "high" ? "default" : "muted"}>
              {reasonLabel(r.suggestion.reason)}
            </Badge>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">kein Vorschlag</span>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {r.suggestion && (
          <Button size="sm" variant="outline" disabled={busy} onClick={acceptSuggestion}>
            <Check className="size-3.5" />
            Übernehmen
          </Button>
        )}
      </td>
    </tr>
  );
}

function PricesSection({
  period,
  readiness,
  onChange,
}: {
  period: string;
  readiness: Readiness | null;
  onChange: () => Promise<void>;
}) {
  const unpriced = readiness?.unpriced ?? [];
  const uncovered = readiness?.uncoveredPools ?? [];
  if (unpriced.length === 0 && uncovered.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Preise und Pools</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {unpriced.length > 0 && (
          <Card className="space-y-2 p-4">
            <div className="text-xs font-medium text-amber-500">Kunden ohne Vertragsposition</div>
            <p className="text-xs text-muted-foreground">
              Diese Kunden verursachen Kosten, aber es wird ihnen nichts berechnet. Lege hier
              schnell eine monatliche Pauschale ab {formatPeriod(period)} an oder pflege die
              Positionen am Kunden.
            </p>
            <div className="space-y-1">
              {unpriced.map((u) => (
                <div key={u.customerId} className="flex items-center gap-2 text-sm">
                  <Link
                    to="/customers/$id"
                    params={{ id: u.customerId }}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {u.name}
                  </Link>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Kosten {formatEuro(u.costCents)}
                  </span>
                  <QuickFlatRate customerId={u.customerId} period={period} onSaved={onChange} />
                </div>
              ))}
            </div>
          </Card>
        )}
        {uncovered.length > 0 && (
          <Card className="space-y-2 p-4">
            <div className="text-xs font-medium text-amber-500">Nicht verteilte Kostenpools</div>
            <p className="text-xs text-muted-foreground">
              Diese Beträge zahlst du, aber keine Ressource zieht daraus Kosten. Verteile sie unter{" "}
              <Link to="/costs" className="text-primary hover:underline">
                Kosten
              </Link>
              .
            </p>
            <div className="space-y-1">
              {uncovered.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-sm">
                  <ConnectorGlyph
                    connectorId={p.provider}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatEuro(p.amountCents)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}

/** Creates a monthly "Pauschale" position starting in the period. */
function QuickFlatRate({
  customerId,
  period,
  onSaved,
}: {
  customerId: string;
  period: string;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const unitPriceCents = parseEuroToCents(value);
    if (unitPriceCents == null || unitPriceCents <= 0) return;
    setBusy(true);
    try {
      await orpcClient.contracts.upsert({
        customerId,
        label: "Pauschale",
        quantity: 1,
        unitPriceCents,
        interval: "monthly",
        startsPeriod: period,
      });
      setValue("");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Position konnte nicht angelegt werden");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Input
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
      placeholder="€ / Monat"
      className="h-8 w-28 text-right tabular-nums"
      inputMode="decimal"
    />
  );
}

function StatementsSection({
  period,
  statements,
  loading,
  error,
}: {
  period: string;
  statements: Statement[];
  loading: boolean;
  error: boolean;
}) {
  const qc = useQueryClient();
  const [invoicing, setInvoicing] = useState(false);
  const invoicedQuery = useQuery(
    orpc.invoices.invoicedCustomers.queryOptions({ input: { period } }),
  );
  const invoiced = useMemo(() => new Set(invoicedQuery.data ?? []), [invoicedQuery.data]);

  async function refreshInvoices() {
    await qc.invalidateQueries({ queryKey: orpc.invoices.key() });
  }

  async function createAll() {
    setInvoicing(true);
    try {
      const { created, skipped } = await orpcClient.invoices.createForPeriod({ period });
      toast.success(
        created.length === 0
          ? "Keine neue Rechnung nötig."
          : `${created.length} ${created.length === 1 ? "Rechnung" : "Rechnungen"} erstellt${skipped > 0 ? `, ${skipped} bereits vorhanden` : ""}.`,
      );
      await refreshInvoices();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rechnungen konnten nicht erstellt werden");
    } finally {
      setInvoicing(false);
    }
  }

  const billable = statements.filter((s) => s.billable && (s.costCents > 0 || s.chargeCents > 0));
  const overhead = statements.filter((s) => !s.billable && s.costCents > 0);
  const totals = useMemo(
    () => ({
      cost: billable.reduce((s, x) => s + x.costCents, 0),
      charge: billable.reduce((s, x) => s + x.chargeCents, 0),
      overhead: overhead.reduce((s, x) => s + x.costCents, 0),
    }),
    [billable, overhead],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Abrechnung je Kunde ({formatPeriod(period)})</h2>
          <p className="text-xs text-muted-foreground">
            Jede Zeile lässt sich aufklappen und zeigt, was berechnet wird und welche Ressource
            welchen Anteil der Kosten trägt. Positionen pflegst du am Kunden.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={invoicing || billable.length === 0}
          onClick={createAll}
        >
          <ReceiptEuro className="size-4" />
          Rechnungen für {formatPeriod(period)} erstellen
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Total label="Kosten (Kunden)" cents={totals.cost} />
        <Total label="Berechnet (Kunden)" cents={totals.charge} />
        <Total label="Marge" cents={totals.charge - totals.cost} signed />
      </div>

      <Card className="overflow-hidden p-0">
        {error ? (
          <div className="p-6 text-center text-xs text-red-500">
            Abrechnung konnte nicht geladen werden. Bitte erneut versuchen.
          </div>
        ) : loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Lade Abrechnung…</div>
        ) : billable.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Für {formatPeriod(period)} gibt es noch keine Kosten oder Preise bei Kunden.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-4 py-2 text-left font-medium">Kunde</th>
                  <th className="px-4 py-2 text-right font-medium">Ressourcen</th>
                  <th className="px-4 py-2 text-right font-medium">Kosten</th>
                  <th className="px-4 py-2 text-right font-medium">Preis</th>
                  <th className="px-4 py-2 text-right font-medium">Marge</th>
                </tr>
              </thead>
              <tbody>
                {billable.map((s) => (
                  <StatementRow
                    key={periodScopedKey(period, s.customerId)}
                    statement={s}
                    period={period}
                    invoiced={invoiced.has(s.customerId)}
                    onInvoiced={refreshInvoices}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {overhead.length > 0 && (
        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">
              Eigenaufwand (intern und Anbieter)
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatEuro(totals.overhead)}
            </span>
          </div>
          <div className="space-y-1">
            {overhead.map((s) => (
              <div key={s.customerId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <Badge variant="muted">
                  {KIND_LABEL[s.kind as keyof typeof KIND_LABEL] ?? s.kind}
                </Badge>
                <span className="w-24 text-right tabular-nums text-muted-foreground">
                  {formatEuro(s.costCents)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

function StatementRow({
  statement: s,
  period,
  invoiced,
  onInvoiced,
}: {
  statement: Statement;
  period: string;
  invoiced: boolean;
  onInvoiced: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  async function createInvoice() {
    setBusy(true);
    try {
      const invoice = await orpcClient.invoices.create({ customerId: s.customerId, period });
      toast.success(`Rechnung ${invoice.number} als Entwurf erstellt.`);
      await onInvoiced();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rechnung konnte nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Fragment>
      <tr className="border-b border-border/50 hover:bg-accent/40 last:border-0">
        <td className="px-2 py-2 text-muted-foreground">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? "Aufstellung einklappen" : "Aufstellung aufklappen"}
            className="flex size-6 items-center justify-center rounded hover:bg-accent hover:text-foreground"
          >
            <Chevron className="size-4" />
          </button>
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/customers/$id"
              params={{ id: s.customerId }}
              className="font-medium hover:underline"
            >
              {s.name}
            </Link>
            {s.revenueLines.length === 0 && s.costCents > 0 && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                keine Position
              </Badge>
            )}
            {invoiced ? (
              <Link
                to="/invoices"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                <FileText className="size-3" />
                berechnet
              </Link>
            ) : (
              s.chargeCents !== 0 && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={createInvoice}>
                  <ReceiptEuro className="size-4" />
                  Rechnung erstellen
                </Button>
              )
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">
          {s.lines.length}
          {s.freeResourceCount > 0 && (
            <span title="Ressourcen ohne Kosten in diesem Monat">
              {" "}
              (+{s.freeResourceCount} ohne Kosten)
            </span>
          )}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
          {formatEuro(s.costCents)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums">
          {formatEuro(s.chargeCents)}
          {s.revenueLines.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {s.revenueLines.length} {s.revenueLines.length === 1 ? "Position" : "Positionen"}
            </div>
          )}
        </td>
        <td
          className={cn(
            "px-4 py-2 text-right tabular-nums",
            s.marginCents < 0 ? "text-red-500" : "text-emerald-500",
          )}
        >
          {formatEuro(s.marginCents)}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-muted/20 last:border-0">
          <td />
          <td colSpan={5} className="space-y-3 px-4 py-3">
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Berechnet
              </div>
              {s.revenueLines.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  Keine Vertragsposition.{" "}
                  <Link
                    to="/customers/$id"
                    params={{ id: s.customerId }}
                    className="text-primary hover:underline"
                  >
                    Am Kunden anlegen
                  </Link>
                  .
                </div>
              ) : (
                <div className="space-y-0.5">
                  {s.revenueLines.map((l, i) => (
                    <div key={l.id ?? `adj-${i}`} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate">{l.label}</span>
                      <span className="hidden text-muted-foreground sm:inline">
                        {l.kind === "adjustment"
                          ? "einmalig"
                          : `${l.quantity} × ${formatEuro(l.unitPriceCents)} ${INTERVAL_LABEL[l.interval ?? "monthly"]}`}
                      </span>
                      <span className="w-24 text-right tabular-nums">
                        {formatEuro(l.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Kosten
            </div>
            {s.lines.length === 0 ? (
              <div className="py-1 text-xs text-muted-foreground">
                Keine Ressource dieses Kunden zieht in {formatPeriod(period)} Kosten.
              </div>
            ) : (
              <div className="space-y-0.5">
                {s.lines.map((l) => (
                  <div key={l.resourceId} className="flex items-center gap-2 py-0.5 text-xs">
                    <ConnectorGlyph
                      connectorId={l.provider}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate" title={l.name}>
                      {l.name}
                    </span>
                    <span className="hidden text-muted-foreground sm:inline">
                      {resourceTypeLabel(l.type)}
                    </span>
                    <span className="w-24 text-right tabular-nums">{formatEuro(l.costCents)}</span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Total({ label, cents, signed }: { label: string; cents: number; signed?: boolean }) {
  const color = signed ? (cents < 0 ? "text-red-500" : "text-emerald-500") : "";
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", color)}>
        {formatEuro(cents)}
      </div>
    </Card>
  );
}
