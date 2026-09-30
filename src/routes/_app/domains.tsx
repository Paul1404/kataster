import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
import { orpc, orpcClient } from "@/lib/orpc";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/domains")({
  component: DomainsPage,
});

type CustomerLite = { id: string; name: string };

function DomainsPage() {
  const [view, setView] = useState<"domains" | "mailboxes">("domains");
  const queryClient = useQueryClient();

  const domainsQuery = useQuery(orpc.mail.domains.list.queryOptions());
  const locationsQuery = useQuery(orpc.customers.list.queryOptions());
  const domains = domainsQuery.data ?? [];
  const customers: CustomerLite[] = (locationsQuery.data ?? []).map((l) => ({
    id: l.id,
    name: l.name,
  }));

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.mail.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.map.key() }),
    ]);
  }

  return (
    <div>
      <PageHeader
        title="Mail-Domains"
        description="Mailcow-Domains und Postfächer den Kunden zuordnen, denen sie gehören."
      />
      <div className="space-y-6 p-8">
        <div className="inline-flex rounded-lg border border-border p-1">
          {(["domains", "mailboxes"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm transition-colors",
                view === v
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "domains" ? "Domains" : "Postfächer"}
            </button>
          ))}
        </div>

        {domainsQuery.isError ? (
          <Card className="p-8 text-center text-sm text-red-500">
            Mail-Domains konnten nicht geladen werden. Bitte erneut versuchen.
          </Card>
        ) : domains.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Noch keine Mailcow-Domains. Lege eine Mailcow-Prüfung an und warte auf den ersten
            Durchlauf, dann erscheinen Domains und Postfächer hier.
          </Card>
        ) : view === "domains" ? (
          <DomainsView domains={domains} customers={customers} onChange={invalidate} />
        ) : (
          <MailboxesView domains={domains} customers={customers} onChange={invalidate} />
        )}
      </div>
    </div>
  );
}

type DomainRow = {
  id: string;
  assetId: string;
  name: string;
  customerId: string | null;
  active: boolean;
  mailboxCount: number;
  serverName: string | null;
  locationName: string | null;
};

function DomainsView({
  domains,
  customers,
  onChange,
}: {
  domains: DomainRow[];
  customers: CustomerLite[];
  onChange: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeMailboxes, setIncludeMailboxes] = useState(true);

  const groups = useMemo(() => {
    const map = new Map<string, DomainRow[]>();
    for (const d of domains) {
      const key = d.serverName ?? "Unbekannter Server";
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [domains]);

  const unassignedIds = domains.filter((d) => !d.customerId).map((d) => d.id);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assign(customerId: string | null) {
    if (selected.size === 0) return;
    try {
      await orpcClient.mail.domains.assign({
        domainIds: [...selected],
        customerId,
        includeMailboxes,
      });
      setSelected(new Set());
      await onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Domain konnte nicht aktualisiert werden");
    }
  }

  return (
    <div className="space-y-4">
      <AssignBar
        count={selected.size}
        customers={customers}
        onAssign={assign}
        onSelectAll={() => setSelected(new Set(unassignedIds))}
        selectAllLabel={`Nicht zugeordnete wählen (${unassignedIds.length})`}
        onClear={() => setSelected(new Set())}
        extra={
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={includeMailboxes}
              onChange={(e) => setIncludeMailboxes(e.target.checked)}
            />
            Postfächer einschließen
          </label>
        }
      />

      {groups.map(([server, rows]) => (
        <Card key={server} className="overflow-hidden">
          <div className="border-b border-border bg-card/60 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {server}
          </div>
          <div className="divide-y divide-border">
            {rows.map((d) => (
              <label
                key={d.id}
                className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(d.id)}
                  onChange={() => toggle(d.id)}
                />
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: d.active ? "#14b8c4" : "#64748b" }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {d.mailboxCount} Postf.
                </span>
                <span
                  className={cn(
                    "w-32 shrink-0 truncate text-right text-xs",
                    d.locationName ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {d.locationName ?? "nicht zugeordnet"}
                </span>
              </label>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function MailboxesView({
  domains,
  customers,
  onChange,
}: {
  domains: DomainRow[];
  customers: CustomerLite[];
  onChange: () => Promise<void>;
}) {
  const servers = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of domains) if (d.serverName) map.set(d.assetId, d.serverName);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [domains]);

  const [assetId, setAssetId] = useState(servers[0]?.id ?? "");
  const [domainName, setDomainName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const domainOptions = domains.filter((d) => d.assetId === assetId);

  const mailboxesQuery = useQuery(
    orpc.mail.mailboxes.list.queryOptions({
      input: { assetId, domainName: domainName || undefined },
      enabled: Boolean(assetId),
    }),
  );
  const mailboxes = mailboxesQuery.data ?? [];
  const unassignedIds = mailboxes.filter((m) => !m.customerId).map((m) => m.id);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assign(customerId: string | null) {
    if (selected.size === 0) return;
    try {
      await orpcClient.mail.mailboxes.assign({ mailboxIds: [...selected], customerId });
      setSelected(new Set());
      await onChange();
      await mailboxesQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select
          value={assetId}
          onValueChange={(v) => {
            setAssetId(v);
            setDomainName("");
            setSelected(new Set());
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={domainName || "all"}
          onValueChange={(v) => setDomainName(v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Alle Domains" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Domains</SelectItem>
            {domainOptions.map((d) => (
              <SelectItem key={d.id} value={d.name}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AssignBar
        count={selected.size}
        customers={customers}
        onAssign={assign}
        onSelectAll={() => setSelected(new Set(unassignedIds))}
        selectAllLabel={`Nicht zugeordnete wählen (${unassignedIds.length})`}
        onClear={() => setSelected(new Set())}
      />

      <Card className="divide-y divide-border">
        {mailboxes.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {mailboxesQuery.isLoading ? "Lade…" : "Keine Postfächer für diesen Filter."}
          </div>
        ) : (
          mailboxes.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.has(m.id)}
                onChange={() => toggle(m.id)}
              />
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: m.active ? "#14b8c4" : "#64748b" }}
              />
              <span className="min-w-0 flex-1 truncate">{m.address}</span>
              <span
                className={cn(
                  "w-32 shrink-0 truncate text-right text-xs",
                  m.locationName ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {m.locationName ?? "nicht zugeordnet"}
              </span>
            </label>
          ))
        )}
      </Card>
    </div>
  );
}

function AssignBar({
  count,
  customers,
  onAssign,
  onSelectAll,
  selectAllLabel,
  onClear,
  extra,
}: {
  count: number;
  customers: CustomerLite[];
  onAssign: (customerId: string | null) => Promise<void>;
  onSelectAll: () => void;
  selectAllLabel: string;
  onClear: () => void;
  extra?: React.ReactNode;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(customerId: string | null) {
    setBusy(true);
    try {
      await onAssign(customerId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-3">
      <Button variant="outline" size="sm" onClick={onSelectAll}>
        {selectAllLabel}
      </Button>
      {count > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={onClear}
        >
          Auswahl aufheben ({count})
        </button>
      )}
      {extra}
      <div className="ml-auto flex items-center gap-2">
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Kunde wählen" />
          </SelectTrigger>
          <SelectContent>
            {customers.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button disabled={busy || count === 0 || !target} onClick={() => run(target)}>
          Zuordnen {count || ""}
        </Button>
        <Button variant="outline" disabled={busy || count === 0} onClick={() => run(null)}>
          Zuordnung entfernen
        </Button>
      </div>
    </div>
  );
}
