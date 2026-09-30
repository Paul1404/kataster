import { Badge } from "@/components/ui/badge";

/** German labels for the invoice lifecycle, shared by the list and the document. */
export const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: "Entwurf",
  issued: "Festgeschrieben",
  paid: "Bezahlt",
  void: "Storniert",
};

const STATUS_CLASS: Record<string, string> = {
  draft: "border-border text-muted-foreground",
  issued: "border-primary/40 text-primary",
  paid: "border-emerald-500/40 text-emerald-500",
  void: "border-red-500/40 text-red-500",
};

export function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status] ?? "border-border"}>
      {INVOICE_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
