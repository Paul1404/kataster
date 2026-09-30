import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AtSign, MapPin, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { CustomerForm, type CustomerRecord } from "@/components/customers/customer-form";
import { CapabilityDots } from "@/components/map/capability-dots";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-badge";
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
import { KIND_LABEL } from "@/lib/customer";
import { resourceTypeLabel } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const Route = createFileRoute("/_app/customers/")({
  component: CustomersPage,
});

const STATUS_LABEL: Record<string, string> = {
  active: "aktiv",
  prospect: "Interessent",
  churned: "abgewandert",
};

function CustomersPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CustomerRecord | null>(null);
  const [creating, setCreating] = useState(false);

  const locationsQuery = useQuery(orpc.customers.list.queryOptions());
  const customers = locationsQuery.data ?? [];

  async function invalidateAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.customers.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.assets.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.mail.mailboxes.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.dashboard.map.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.resources.key() }),
    ]);
  }

  async function handleDelete(id: string) {
    if (!confirm("Diesen Kunden löschen? Das lässt sich nicht rückgängig machen.")) return;
    try {
      await orpcClient.customers.remove({ id });
      await invalidateAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kunde konnte nicht gelöscht werden");
    }
  }

  return (
    <div>
      <PageHeader
        title="Kunden"
        description="Kunden einmal anlegen, dann ihre Ressourcen zuordnen. Kunden bestimmen die Karte und die Abrechnung."
        actions={
          !creating &&
          !editing && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Neuer Kunde
            </Button>
          )
        }
      />

      <div className="grid gap-8 p-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {(creating || editing) && (
            <CustomerForm
              location={editing ?? undefined}
              onDone={() => {
                setCreating(false);
                setEditing(null);
              }}
              onCancel={() => {
                setCreating(false);
                setEditing(null);
              }}
            />
          )}

          {locationsQuery.isError ? (
            <Card className="p-8 text-center text-sm text-red-500">
              Kunden konnten nicht geladen werden. Bitte erneut versuchen.
            </Card>
          ) : customers.length === 0 && !creating ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Noch keine Kunden. Lege einen an, um ihm Ressourcen zuzuordnen.
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {customers.map((loc) => (
                <Card key={loc.id} className="flex items-start justify-between gap-3 p-4">
                  <Link
                    to="/customers/$id"
                    params={{ id: loc.id }}
                    className="group min-w-0 flex-1"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium group-hover:underline">{loc.name}</span>
                      {loc.customerNumber && (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {loc.customerNumber}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="muted">{KIND_LABEL[loc.kind]}</Badge>
                      {loc.status !== "active" && (
                        <Badge variant="outline">{STATUS_LABEL[loc.status] ?? loc.status}</Badge>
                      )}
                    </div>
                    {loc.address && (
                      <div className="mt-1.5 truncate text-xs text-muted-foreground">
                        {loc.address}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Users className="size-3.5" />
                        {loc.resourceCount} {loc.resourceCount === 1 ? "Ressource" : "Ressourcen"}
                      </span>
                      <CapabilityDots
                        capabilities={{
                          hasDns: loc.hasDns,
                          hasMail: loc.hasMail,
                          hasWeb: loc.hasWeb,
                          hasRegistry: loc.hasRegistry,
                          hasCloudfront: loc.hasCloudfront,
                          registryExpiresAt: loc.registryExpiresAt,
                        }}
                        size={13}
                      />
                    </div>
                  </Link>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setCreating(false);
                        setEditing(loc);
                      }}
                      aria-label="Kunde bearbeiten"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(loc.id)}
                      aria-label="Kunde löschen"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <AssignPanel
          customers={customers.map((l) => ({ id: l.id, name: l.name }))}
          onAssigned={invalidateAll}
        />
      </div>
    </div>
  );
}

function AssignPanel({
  customers,
  onAssigned,
}: {
  customers: { id: string; name: string }[];
  onAssigned: () => Promise<void>;
}) {
  const assetsQuery = useQuery(orpc.assets.list.queryOptions());
  const mailboxesQuery = useQuery(orpc.mail.mailboxes.list.queryOptions({ input: {} }));
  const resourcesQuery = useQuery(orpc.resources.list.queryOptions({ input: {} }));

  const [target, setTarget] = useState("");
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const locationName = useMemo(() => new Map(customers.map((l) => [l.id, l.name])), [customers]);

  // Assets and mailboxes both carry an independent owner, so both are assignable
  // here. A mailbox can belong to a different customer than its mail domain.
  // Keys are namespaced so the two id spaces never collide and assign can route.
  const items = useMemo(() => {
    const assetItems = (assetsQuery.data ?? []).map((a) => ({
      key: `asset:${a.id}`,
      id: a.id,
      kind: "asset" as const,
      name: a.name,
      customerId: a.customerId,
      connectorId: a.connectorId,
      lastStatus: a.lastStatus,
    }));
    const mailboxItems = (mailboxesQuery.data ?? []).map((m) => ({
      key: `mailbox:${m.id}`,
      id: m.id,
      kind: "mailbox" as const,
      name: m.address,
      customerId: m.customerId,
      connectorId: null,
      lastStatus: null,
    }));
    const resourceItems = (resourcesQuery.data ?? []).map((r) => ({
      key: `resource:${r.id}`,
      id: r.id,
      kind: "resource" as const,
      name: r.name,
      customerId: r.ownerCustomerId,
      connectorId: r.provider,
      lastStatus: null,
      provider: r.provider,
      resourceType: r.type,
    }));
    return [
      ...assetItems.map((item) => ({ ...item, provider: item.connectorId, resourceType: "asset" })),
      ...mailboxItems.map((item) => ({ ...item, provider: "mailcow", resourceType: "mailbox" })),
      ...resourceItems,
    ];
  }, [assetsQuery.data, mailboxesQuery.data, resourcesQuery.data]);

  const providers = [...new Set(items.map((item) => item.provider))].sort();
  const resourceTypes = [...new Set(items.map((item) => item.resourceType))].sort();
  const filteredItems = items.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(search.trim().toLowerCase());
    const matchesProvider = providerFilter === "all" || item.provider === providerFilter;
    const matchesType = typeFilter === "all" || item.resourceType === typeFilter;
    const matchesOwner =
      ownerFilter === "all" ||
      (ownerFilter === "unassigned" ? !item.customerId : item.customerId === ownerFilter);
    return matchesSearch && matchesProvider && matchesType && matchesOwner;
  });
  const unplacedKeys = filteredItems.filter((i) => !i.customerId).map((i) => i.key);

  function toggle(key: string) {
    setDone(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllUnplaced() {
    setDone(null);
    setSelected(new Set(unplacedKeys));
  }

  async function assign(customerId: string | null) {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const assetIds: string[] = [];
      const mailboxIds: string[] = [];
      const resourceIds: string[] = [];
      for (const key of selected) {
        const [kind, id] = key.split(":");
        if (kind === "asset") assetIds.push(id!);
        else if (kind === "mailbox") mailboxIds.push(id!);
        else if (kind === "resource") resourceIds.push(id!);
      }
      await Promise.all([
        assetIds.length > 0 ? orpcClient.customers.assignAssets({ customerId, assetIds }) : null,
        mailboxIds.length > 0 ? orpcClient.mail.mailboxes.assign({ customerId, mailboxIds }) : null,
        resourceIds.length > 0
          ? orpcClient.resources.assignOwners({ resourceIds, customerId })
          : null,
      ]);
      const count = selected.size;
      setSelected(new Set());
      setDone(
        customerId
          ? `${count} an ${locationName.get(customerId) ?? "Kunde"} zugeordnet.`
          : `Zuordnung von ${count} entfernt.`,
      );
      await onAssigned();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex h-fit flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <MapPin className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Ressourcen zuordnen</div>
      </div>
      <p className="text-xs text-muted-foreground">
        Das gesamte Inventar durchsuchen, Ressourcen auswählen und in einem Schritt zuordnen. Die
        Zuordnung eines Railway-Projekts gilt auch für seine Services.
      </p>

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Ressourcen suchen"
      />
      <div className="grid grid-cols-3 gap-2">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Anbieter</SelectItem>
            {providers.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Typen</SelectItem>
            {resourceTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {resourceTypeLabel(type)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Eigentümer</SelectItem>
            <SelectItem value="unassigned">Nicht zugeordnet</SelectItem>
            {customers.map((customer) => (
              <SelectItem key={customer.id} value={customer.id}>
                {customer.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={selectAllUnplaced}
          disabled={unplacedKeys.length === 0}
        >
          Nicht zugeordnete wählen ({unplacedKeys.length})
        </Button>
        {selected.size > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setSelected(new Set())}
          >
            Auswahl aufheben ({selected.size})
          </button>
        )}
      </div>

      <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-border p-1">
        {filteredItems.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">Noch nichts zum Zuordnen.</div>
        ) : (
          filteredItems.map((i) => {
            return (
              <label
                key={i.key}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(i.key)}
                  onChange={() => toggle(i.key)}
                />
                {i.kind === "asset" ? (
                  <>
                    <StatusDot status={i.lastStatus ?? "unknown"} />
                    <ConnectorGlyph
                      connectorId={i.connectorId ?? "http"}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  </>
                ) : i.kind === "resource" ? (
                  <ConnectorGlyph
                    connectorId={i.connectorId ?? "custom"}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <AtSign className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:block">
                  {resourceTypeLabel(i.resourceType)}
                </span>
                {i.customerId && (
                  <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                    {locationName.get(i.customerId) ?? "zugeordnet"}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>

      <div className="space-y-2">
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger>
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
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={busy || selected.size === 0 || !target}
            onClick={() => assign(target)}
          >
            Zuordnen {selected.size > 0 ? selected.size : ""}
          </Button>
          <Button
            variant="outline"
            disabled={busy || selected.size === 0}
            onClick={() => assign(null)}
            title="Zuordnung der gewählten Einträge entfernen"
          >
            Entfernen
          </Button>
        </div>
        {done && <p className="text-xs text-muted-foreground">{done}</p>}
      </div>
    </Card>
  );
}
