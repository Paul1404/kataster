import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Ban, Check, FileText, Lock, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  INVOICE_STATUS_LABEL,
  InvoiceStatusBadge,
} from "@/components/invoices/invoice-status-badge";
import { ListToolbar } from "@/components/list-toolbar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatEuro, formatPeriod } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const Route = createFileRoute("/_app/invoices/")({
  component: InvoicesPage,
});

function InvoicesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  const invoicesQuery = useQuery(orpc.invoices.list.queryOptions());
  const rows = useMemo(() => invoicesQuery.data ?? [], [invoicesQuery.data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (statusFilter === "all" || r.status === statusFilter) &&
        (!q ||
          r.number.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q) ||
          r.period.includes(q)),
    );
  }, [rows, search, statusFilter]);

  const openTotal = shown
    .filter((r) => r.status === "issued")
    .reduce((sum, r) => sum + r.totalCents, 0);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await qc.invalidateQueries({ queryKey: orpc.invoices.key() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Rechnungen"
        description="Rechnungsdokumente aus der Abrechnung. Eine Rechnung ist eine Momentaufnahme: Positionen, Beträge und Empfänger bleiben unverändert, auch wenn sich der Vertrag später ändert."
      />

      <div className="space-y-4 p-8">
        <ListToolbar search={search} onSearch={setSearch} placeholder="Nummer oder Kunde suchen">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Status</SelectItem>
              {Object.entries(INVOICE_STATUS_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {openTotal !== 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              Offen: {formatEuro(openTotal)}
            </span>
          )}
        </ListToolbar>

        <Card className="overflow-hidden p-0">
          {invoicesQuery.isLoading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">Lade Rechnungen…</div>
          ) : invoicesQuery.isError ? (
            <div className="p-6 text-center text-xs text-red-500">
              Rechnungen konnten nicht geladen werden. Bitte erneut versuchen.
            </div>
          ) : rows.length === 0 ? (
            <div className="space-y-1 p-6 text-center text-xs text-muted-foreground">
              <div>Noch keine Rechnung erstellt.</div>
              <div>
                Rechnungen entstehen auf der{" "}
                <Link to="/billing" className="text-primary hover:underline">
                  Abrechnung
                </Link>{" "}
                für einen Zeitraum.
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              Keine Rechnung passt zum Filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Nummer</th>
                    <th className="px-4 py-2 text-left font-medium">Kunde</th>
                    <th className="px-4 py-2 text-left font-medium">Zeitraum</th>
                    <th className="px-4 py-2 text-right font-medium">Betrag</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-left font-medium">Rechnungsdatum</th>
                    <th className="px-4 py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/50 last:border-0 hover:bg-accent/40"
                    >
                      <td className="px-4 py-2">
                        <Link
                          to="/invoices/$id"
                          params={{ id: r.id }}
                          className="font-medium tabular-nums hover:underline"
                        >
                          {r.number}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          to="/customers/$id"
                          params={{ id: r.customerId }}
                          className="hover:underline"
                        >
                          {r.customerName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{formatPeriod(r.period)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatEuro(r.totalCents)}
                      </td>
                      <td className="px-4 py-2">
                        <InvoiceStatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                        {r.issuedAt ? formatDate(r.issuedAt) : "noch nicht festgeschrieben"}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button asChild size="sm" variant="ghost" title="Dokument öffnen">
                            <Link to="/invoices/$id" params={{ id: r.id }}>
                              <FileText className="size-4" />
                            </Link>
                          </Button>
                          {r.status === "draft" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              title="Festschreiben"
                              onClick={() =>
                                act("Rechnung festgeschrieben.", () =>
                                  orpcClient.invoices.issue({ id: r.id }),
                                )
                              }
                            >
                              <Lock className="size-4" />
                            </Button>
                          )}
                          {r.status === "issued" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              title="Als bezahlt markieren"
                              onClick={() =>
                                act("Rechnung als bezahlt markiert.", () =>
                                  orpcClient.invoices.markPaid({ id: r.id }),
                                )
                              }
                            >
                              <Check className="size-4" />
                            </Button>
                          )}
                          {(r.status === "draft" || r.status === "issued") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              title="Stornieren"
                              onClick={() => {
                                if (!confirm(`Rechnung ${r.number} stornieren?`)) return;
                                act("Rechnung storniert.", () =>
                                  orpcClient.invoices.void({ id: r.id }),
                                );
                              }}
                            >
                              <Ban className="size-4" />
                            </Button>
                          )}
                          {r.status === "draft" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              title="Entwurf löschen"
                              onClick={() => {
                                if (!confirm(`Entwurf ${r.number} löschen?`)) return;
                                act("Entwurf gelöscht.", () =>
                                  orpcClient.invoices.remove({ id: r.id }),
                                );
                              }}
                            >
                              <Trash2 className="size-4 text-red-500" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
