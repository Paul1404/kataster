import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status-badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatEuro, formatPeriod } from "@/lib/format";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/invoices/$id")({
  component: InvoiceDocumentPage,
});

// Print rules for the document. The app chrome (sidebar, header, buttons) is
// hidden and the sheet is rendered black on white, so the browser's own "save as
// PDF" produces a usable invoice without a PDF library.
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 18mm 16mm; }
  body { background: #fff !important; }
  aside, header, .no-print { display: none !important; }
  main { min-width: 0 !important; }
  .invoice-sheet {
    color: #000 !important;
    background: #fff !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    font-size: 11pt;
  }
  .invoice-sheet * { color: #000 !important; border-color: #999 !important; }
  .invoice-sheet a { text-decoration: none !important; }
  .invoice-sheet thead { display: table-header-group; }
  .invoice-sheet tr { break-inside: avoid; }
}
`;

function InvoiceDocumentPage() {
  const { id } = Route.useParams();
  const query = useQuery(orpc.invoices.get.queryOptions({ input: { id } }));

  if (query.isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Lade Rechnung…</div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-3 p-8">
        <div className="text-sm text-red-500">Rechnung konnte nicht geladen werden.</div>
        <Button asChild variant="outline" size="sm">
          <Link to="/invoices">
            <ArrowLeft className="size-4" />
            Zurück zu den Rechnungen
          </Link>
        </Button>
      </div>
    );
  }

  const { invoice, lines, sender, paymentTermDays } = query.data;
  const smallBusiness = invoice.vatRatePercent === 0;

  return (
    <div className="p-8">
      {/** biome-ignore lint/security/noDangerouslySetInnerHtml: static print stylesheet, no user input. */}
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/invoices">
              <ArrowLeft className="size-4" />
              Rechnungen
            </Link>
          </Button>
          <InvoiceStatusBadge status={invoice.status} />
          {invoice.status === "draft" && (
            <span className="text-xs text-muted-foreground">
              Entwurf. Erst nach dem Festschreiben versenden.
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="size-4" />
          Drucken
        </Button>
      </div>

      <div className="invoice-sheet mx-auto max-w-[210mm] rounded-lg border border-border bg-card p-10 text-sm leading-relaxed text-foreground">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-[60%] whitespace-pre-line text-xs text-muted-foreground">
            {sender.configured ? (
              <>
                <div className="text-sm font-semibold text-foreground">{sender.name}</div>
                {sender.address}
              </>
            ) : (
              <div>
                Absenderangaben fehlen. Setze INVOICE_SENDER_NAME, INVOICE_SENDER_ADDRESS,
                INVOICE_SENDER_EMAIL, INVOICE_SENDER_VAT_ID und INVOICE_SENDER_IBAN in der Umgebung.
              </div>
            )}
          </div>
          <div className="text-right text-xs">
            <div className="text-lg font-semibold tracking-tight">Rechnung</div>
            <dl className="mt-2 space-y-0.5">
              <Meta label="Rechnungsnummer" value={invoice.number} />
              <Meta
                label="Rechnungsdatum"
                value={invoice.issuedAt ? formatDate(invoice.issuedAt) : "offen (Entwurf)"}
              />
              <Meta label="Leistungszeitraum" value={formatPeriod(invoice.period)} />
              {invoice.recipient.customerNumber && (
                <Meta label="Kundennummer" value={invoice.recipient.customerNumber} />
              )}
            </dl>
          </div>
        </header>

        <section className="mt-10">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Empfänger</div>
          <div className="mt-1 whitespace-pre-line">
            <div className="font-medium">{invoice.recipient.name}</div>
            {invoice.recipient.address ?? (
              <span className="text-xs text-muted-foreground">
                Keine Rechnungsanschrift erfasst
              </span>
            )}
          </div>
          {invoice.recipient.vatId && (
            <div className="mt-1 text-xs text-muted-foreground">
              USt-IdNr. {invoice.recipient.vatId}
            </div>
          )}
        </section>

        <table className="mt-8 w-full text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-medium">Pos.</th>
              <th className="py-2 text-left font-medium">Leistung</th>
              <th className="py-2 text-right font-medium">Menge</th>
              <th className="py-2 text-right font-medium">Einzelpreis</th>
              <th className="py-2 text-right font-medium">Betrag</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-b border-border/50">
                <td className="py-2 align-top tabular-nums text-muted-foreground">
                  {line.position}
                </td>
                <td className="py-2 align-top">{line.label}</td>
                <td className="py-2 text-right align-top tabular-nums">{line.quantity}</td>
                <td className="py-2 text-right align-top tabular-nums">
                  {formatEuro(line.unitPriceCents)}
                </td>
                <td className="py-2 text-right align-top tabular-nums">
                  {formatEuro(line.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-6 flex justify-end">
          <dl className="w-64 space-y-1 text-sm">
            <Amount label="Nettobetrag" cents={invoice.subtotalCents} />
            {!smallBusiness && (
              <Amount label={`Umsatzsteuer ${invoice.vatRatePercent} %`} cents={invoice.vatCents} />
            )}
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <dt>Gesamtbetrag</dt>
              <dd className="tabular-nums">{formatEuro(invoice.totalCents)}</dd>
            </div>
          </dl>
        </section>

        {smallBusiness && (
          <p className="mt-6 text-xs text-muted-foreground">
            Gemäß Paragraph 19 UStG wird keine Umsatzsteuer berechnet.
          </p>
        )}

        <section className="mt-8 space-y-1 text-xs text-muted-foreground">
          <p>
            {invoice.dueAt
              ? `Zahlbar ohne Abzug bis zum ${formatDate(invoice.dueAt)}.`
              : `Zahlbar ohne Abzug innerhalb von ${paymentTermDays} Tagen nach Rechnungsdatum.`}
          </p>
          <p>Bitte gib bei der Überweisung die Rechnungsnummer {invoice.number} an.</p>
          {invoice.note && <p className="whitespace-pre-line">{invoice.note}</p>}
        </section>

        <footer className="mt-10 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {sender.email && <span>E-Mail: {sender.email}</span>}
            {sender.vatId && <span>USt-IdNr.: {sender.vatId}</span>}
            {sender.iban && <span>IBAN: {sender.iban}</span>}
          </div>
          {!sender.iban && (
            <div className="mt-1">Keine Bankverbindung hinterlegt (INVOICE_SENDER_IBAN).</div>
          )}
        </footer>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-end gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Amount({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{formatEuro(cents)}</dd>
    </div>
  );
}
