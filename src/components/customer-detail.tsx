import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, Mail, Phone, User } from "lucide-react";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { ContractPositionsEditor } from "@/components/customers/contract-positions";
import { CapabilityDots } from "@/components/map/capability-dots";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { KIND_LABEL } from "@/lib/customer";
import { formatEuro, formatPeriod, relativeTime, resourceTypeLabel } from "@/lib/format";
import { orpc } from "@/lib/orpc";

// Plural labels for the resource types a customer can own.
const TYPE_LABEL: Record<string, string> = {
  domain: "Domains",
  registered_domain: "Registrierte Domains",
  dns_zone: "DNS-Zonen",
  cloudfront_distribution: "CloudFront",
  cert: "Zertifikate",
  acm_cert: "Zertifikate",
  ses_identity: "SES-Identitäten",
  ses_tenant: "SES-Mandanten",
  mail_domain: "Mail-Domains",
  mailbox: "Postfächer",
  container: "Container",
  host: "Hosts",
  railway_project: "Railway-Projekte",
  railway_service: "Railway-Services",
};

const STATUS_LABEL: Record<string, string> = {
  active: "aktiv",
  prospect: "Interessent",
  churned: "abgewandert",
};

// Resource types that have a Configuration Item detail page.
const CI_TYPES = new Set(["host", "domain"]);

interface OwnedResource {
  id: string;
  type: string;
  provider: string;
  externalId: string;
  name: string;
}

export function CustomerDetail({ id }: { id: string }) {
  const q = useQuery(orpc.customers.get.queryOptions({ input: { id }, refetchInterval: 30_000 }));

  if (q.isLoading) {
    return (
      <div>
        <PageHeader title="Kunde" />
        <div className="p-8 text-sm text-muted-foreground">Lade…</div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div>
        <PageHeader title="Kunde" />
        <div className="p-8 text-sm text-muted-foreground">
          {q.isError ? "Dieser Kunde konnte nicht geladen werden. " : "Nicht gefunden. "}
          <Link to="/customers" className="text-primary hover:underline">
            Zurück
          </Link>
        </div>
      </div>
    );
  }

  const c = q.data;
  const resources = c.resources as OwnedResource[];

  // Group owned resources by type, preserving the query's provider/type/name order.
  const groups = new Map<string, OwnedResource[]>();
  for (const r of resources) {
    const list = groups.get(r.type);
    if (list) list.push(r);
    else groups.set(r.type, [r]);
  }

  return (
    <div>
      <PageHeader
        title={c.name}
        description={`${KIND_LABEL[c.kind]}${c.status !== "active" ? ` · ${STATUS_LABEL[c.status] ?? c.status}` : ""}`}
        actions={
          <Link
            to="/customers"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Zurück
          </Link>
        }
      />
      <div className="space-y-6 p-8">
        {/* Money for the current period */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Money label="Kosten" cents={c.costCents} />
          <Money label="Preis" cents={c.chargeCents} />
          <Money label="Marge" cents={c.marginCents} signed />
        </div>
        {c.revenueLines.length === 0 && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Für {formatPeriod(c.period)} wird nichts berechnet. Lege unten eine Vertragsposition an,
            um die echte Marge zu sehen.
          </p>
        )}

        {/* Billing profile */}
        {(c.customerNumber || c.billingEmail || c.billingAddress || c.vatId) && (
          <Card className="grid gap-x-6 gap-y-1 p-4 text-sm sm:grid-cols-2">
            {c.customerNumber && (
              <div>
                <span className="text-xs text-muted-foreground">Kundennummer </span>
                <span className="font-mono">{c.customerNumber}</span>
              </div>
            )}
            {c.vatId && (
              <div>
                <span className="text-xs text-muted-foreground">USt-IdNr. </span>
                <span className="font-mono">{c.vatId}</span>
              </div>
            )}
            {c.billingEmail && (
              <div>
                <span className="text-xs text-muted-foreground">Rechnung an </span>
                <a href={`mailto:${c.billingEmail}`} className="text-primary hover:underline">
                  {c.billingEmail}
                </a>
              </div>
            )}
            {c.billingAddress && (
              <div className="whitespace-pre-line">
                <span className="text-xs text-muted-foreground">Rechnungsadresse </span>
                {c.billingAddress}
              </div>
            )}
          </Card>
        )}

        <ContractPositionsEditor
          customerId={c.id}
          resources={resources.map((r) => ({ id: r.id, name: r.name }))}
        />

        {/* Profile meta */}
        <div className="flex flex-wrap items-center gap-4">
          <CapabilityDots
            capabilities={{
              hasDns: c.hasDns,
              hasMail: c.hasMail,
              hasWeb: c.hasWeb,
              hasRegistry: c.hasRegistry,
              hasCloudfront: c.hasCloudfront,
              registryExpiresAt: c.registryExpiresAt,
            }}
            size={15}
          />
          {c.address && <span className="text-sm text-muted-foreground">{c.address}</span>}
          {c.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <Badge key={t} variant="muted">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {c.notes && <p className="max-w-2xl text-sm text-muted-foreground">{c.notes}</p>}

        {/* Contacts */}
        {c.contacts.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <User className="size-4" />
              Kontakte ({c.contacts.length})
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {c.contacts.map((ct) => (
                <Card key={ct.id} className="space-y-1 p-4">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{ct.name}</span>
                    {ct.isPrimary && <Badge variant="muted">Hauptkontakt</Badge>}
                  </div>
                  {ct.role && <div className="text-xs text-muted-foreground">{ct.role}</div>}
                  {ct.email && (
                    <a
                      href={`mailto:${ct.email}`}
                      className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                    >
                      <Mail className="size-3" />
                      {ct.email}
                    </a>
                  )}
                  {ct.phone && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Phone className="size-3" />
                      {ct.phone}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Monitored assets */}
        {c.assets.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Boxes className="size-4" />
              Überwacht ({c.assets.length})
            </div>
            <Card className="divide-y divide-border p-0">
              {c.assets.map((a) => (
                <Link
                  key={a.id}
                  to="/assets/$assetId"
                  params={{ assetId: a.id }}
                  className="flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <StatusDot status={a.lastStatus} />
                  <ConnectorGlyph
                    connectorId={a.connectorId}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.lastCheckedAt ? relativeTime(a.lastCheckedAt) : "nie"}
                  </span>
                </Link>
              ))}
            </Card>
          </section>
        )}

        {/* Owned inventory, grouped by type */}
        {resources.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Diesem Kunden ist noch nichts zugeordnet. Ressourcen auf der{" "}
            <Link to="/customers" className="text-primary hover:underline">
              Kundenseite
            </Link>{" "}
            zuordnen.
          </Card>
        ) : (
          <section className="space-y-4">
            <div className="text-sm font-medium">Zugeordnete Ressourcen ({resources.length})</div>
            <div className="grid gap-4 md:grid-cols-2">
              {[...groups].map(([type, list]) => (
                <Card key={type} className="space-y-1 p-4">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <ConnectorGlyph connectorId={list[0]!.provider} className="size-3.5 shrink-0" />
                    {TYPE_LABEL[type] ?? resourceTypeLabel(type)} ({list.length})
                  </div>
                  {list.map((r) =>
                    CI_TYPES.has(r.type) ? (
                      <Link
                        key={r.id}
                        to="/ci/$id"
                        params={{ id: r.id }}
                        className="block truncate rounded px-1.5 py-1 text-sm hover:bg-accent hover:underline"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      <div key={r.id} className="truncate px-1.5 py-1 text-sm">
                        {r.name}
                      </div>
                    ),
                  )}
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Money({ label, cents, signed }: { label: string; cents: number; signed?: boolean }) {
  const color =
    signed && cents < 0 ? "text-red-500" : signed && cents > 0 ? "text-emerald-500" : "";
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {signed && cents > 0 ? "+" : ""}
        {formatEuro(cents)}
      </div>
    </Card>
  );
}
