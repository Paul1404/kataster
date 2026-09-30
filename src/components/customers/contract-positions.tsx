import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { centsToInput, formatEuro, formatPeriod, parseEuroToCents } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const INTERVAL_LABEL: Record<string, string> = {
  monthly: "monatlich",
  yearly: "jährlich",
  once: "einmalig",
};

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Cents a position bills per month, for the row summary. */
function monthlyCents(p: { quantity: number; unitPriceCents: number; interval: string }): number {
  const total = Math.round(p.quantity * p.unitPriceCents);
  return p.interval === "yearly" ? Math.round(total / 12) : total;
}

/**
 * The customer's price model: one row per sold item. Inline add, delete, and
 * end-dating. Amounts are entered per unit; the engine turns them into the
 * period's charge.
 */
export function ContractPositionsEditor({
  customerId,
  resources,
  onChanged,
}: {
  customerId: string;
  resources: { id: string; name: string }[];
  onChanged?: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const q = useQuery(orpc.contracts.list.queryOptions({ input: { customerId } }));
  const positions = q.data ?? [];

  const [label, setLabel] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState<"monthly" | "yearly" | "once">("monthly");
  const [starts, setStarts] = useState(currentPeriod());
  const [resourceId, setResourceId] = useState("none");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: orpc.contracts.key() }),
      qc.invalidateQueries({ queryKey: orpc.customers.key() }),
      qc.invalidateQueries({ queryKey: orpc.billing.key() }),
      qc.invalidateQueries({ queryKey: orpc.costs.key() }),
      onChanged?.(),
    ]);
  }

  async function add() {
    const unitPriceCents = parseEuroToCents(price);
    const qty = Number.parseFloat(quantity.replace(",", "."));
    if (!label.trim() || unitPriceCents == null || !Number.isFinite(qty)) return;
    setBusy(true);
    try {
      await orpcClient.contracts.upsert({
        customerId,
        label: label.trim(),
        quantity: qty,
        unitPriceCents,
        interval,
        startsPeriod: starts,
        resourceId: resourceId === "none" ? null : resourceId,
      });
      setLabel("");
      setQuantity("1");
      setPrice("");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Position konnte nicht angelegt werden");
    } finally {
      setBusy(false);
    }
  }

  async function endNow(p: (typeof positions)[number]) {
    setBusy(true);
    try {
      await orpcClient.contracts.upsert({
        id: p.id,
        customerId: p.customerId,
        resourceId: p.resourceId,
        label: p.label,
        quantity: p.quantity,
        unitPriceCents: p.unitPriceCents,
        interval: p.interval,
        startsPeriod: p.startsPeriod,
        endsPeriod: currentPeriod(),
        note: p.note,
      });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Position konnte nicht beendet werden");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Position löschen? Vergangene Abrechnungen ändern sich rückwirkend.")) return;
    try {
      await orpcClient.contracts.remove({ id });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Position konnte nicht gelöscht werden");
    }
  }

  const now = currentPeriod();
  const active = positions.filter((p) => !p.endsPeriod || p.endsPeriod >= now);
  const monthlyTotal = active
    .filter((p) => p.interval !== "once")
    .reduce((s, p) => s + monthlyCents(p), 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Vertragspositionen ({positions.length})</div>
        <div className="text-xs text-muted-foreground">
          laufend {formatEuro(monthlyTotal)} / Monat
        </div>
      </div>
      <Card className="overflow-hidden p-0">
        {positions.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">
            Noch keine Positionen. Lege unten fest, was dieser Kunde bezahlt.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Position</th>
                <th className="px-3 py-2 text-right font-medium">Menge</th>
                <th className="px-3 py-2 text-right font-medium">Einzelpreis</th>
                <th className="px-3 py-2 text-left font-medium">Turnus</th>
                <th className="px-3 py-2 text-left font-medium">Laufzeit</th>
                <th className="px-3 py-2 text-right font-medium">/ Monat</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const ended = p.endsPeriod != null && p.endsPeriod < now;
                return (
                  <tr
                    key={p.id}
                    className={`border-b border-border/50 last:border-0 ${ended ? "text-muted-foreground" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <div className="truncate">{p.label}</div>
                      {p.resourceName && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.resourceName}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEuro(p.unitPriceCents)}
                    </td>
                    <td className="px-3 py-2 text-xs">{INTERVAL_LABEL[p.interval]}</td>
                    <td className="px-3 py-2 text-xs">
                      ab {formatPeriod(p.startsPeriod)}
                      {p.endsPeriod ? ` bis ${formatPeriod(p.endsPeriod)}` : ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.interval === "once" ? "" : formatEuro(monthlyCents(p))}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {!p.endsPeriod && p.interval !== "once" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => endNow(p)}
                            title="Zum Monatsende kündigen"
                          >
                            Beenden
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(p.id)}
                          aria-label="Position löschen"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
          <Input
            placeholder="Position (z. B. Hosting site.example.test)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="min-w-56 flex-1"
          />
          <Input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-16 text-right"
            inputMode="decimal"
            aria-label="Menge"
          />
          <Input
            placeholder="€ je Einheit"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-28 text-right"
            inputMode="decimal"
          />
          <Select value={interval} onValueChange={(v) => setInterval(v as typeof interval)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">monatlich</SelectItem>
              <SelectItem value="yearly">jährlich</SelectItem>
              <SelectItem value="once">einmalig</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="month"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
            className="w-40"
            aria-label="Beginn"
          />
          {resources.length > 0 && (
            <Select value={resourceId} onValueChange={setResourceId}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Ressource" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Keine Ressource</SelectItem>
                {resources.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button disabled={busy || !label.trim() || parseEuroToCents(price) == null} onClick={add}>
            <Plus className="size-4" />
            Hinzufügen
          </Button>
        </div>
      </Card>
      <p className="text-xs text-muted-foreground">
        Monatliche Positionen gelten ab dem Beginn fortlaufend, jährliche werden auf zwölf Monate
        verteilt, einmalige nur im Startmonat berechnet. Einzelpreis in Euro, z. B.{" "}
        {centsToInput(1250)}.
      </p>
    </section>
  );
}
