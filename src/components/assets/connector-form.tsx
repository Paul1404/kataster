import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { ConnectorGlyph } from "@/components/connector-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { orpc, orpcClient } from "@/lib/orpc";
import type { FieldDescriptor } from "@/server/connectors/schema-to-fields";

type ConnectorMeta = {
  id: string;
  name: string;
  description: string;
  icon: string;
  capabilities: { probe: boolean; inventory: boolean };
  configFields: FieldDescriptor[];
  secretFields: FieldDescriptor[];
  defaultIntervalSeconds?: number;
};

export interface AssetRecord {
  id: string;
  name: string;
  connectorId: string;
  target: string;
  config: Record<string, unknown>;
  tags: string[];
  connectionId: string | null;
  intervalSeconds: number;
  enabled: boolean;
  customerId: string | null;
}

export function ConnectorForm({ asset }: { asset?: AssetRecord }) {
  const connectorsQuery = useQuery(orpc.connectors.list.queryOptions());
  const connectors = (connectorsQuery.data ?? []) as ConnectorMeta[];
  const [connectorId, setConnectorId] = useState(asset?.connectorId ?? "");

  const selected = connectors.find((c) => c.id === connectorId);

  if (connectorsQuery.isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Lade Connectoren…</div>;
  }

  return (
    <div className="max-w-2xl space-y-6 p-8">
      {!asset && (
        <div className="space-y-2">
          <Label>Connector</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {connectors.map((c) => {
              const active = c.id === connectorId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setConnectorId(c.id)}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    active ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                  }`}
                >
                  <ConnectorGlyph
                    connectorId={c.id}
                    className="mt-0.5 size-5 text-muted-foreground"
                  />
                  <div>
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selected && <AssetForm key={selected.id} connector={selected} asset={asset} />}
    </div>
  );
}

function buildDefaultConfig(
  connector: ConnectorMeta,
  asset?: AssetRecord,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of connector.configFields) {
    const existing = asset?.config?.[field.key];
    config[field.key] =
      existing ??
      field.default ??
      (field.type === "boolean" ? false : field.type === "number" ? 0 : "");
  }
  return config;
}

function AssetForm({ connector, asset }: { connector: ConnectorMeta; asset?: AssetRecord }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const connectionsQuery = useQuery(orpc.connections.list.queryOptions());
  const connections = (connectionsQuery.data ?? []).filter((c) => c.connectorId === connector.id);
  const needsConnection = connector.secretFields.length > 0;

  const [discovered, setDiscovered] = useState<{ name: string; target: string }[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const locationsQuery = useQuery(orpc.customers.list.queryOptions());
  const customers = locationsQuery.data ?? [];

  const form = useForm({
    defaultValues: {
      name: asset?.name ?? "",
      // AWS is one asset per account, so the target is fixed to "*".
      target: asset?.target ?? (connector.id === "aws" ? "*" : ""),
      intervalSeconds: asset?.intervalSeconds ?? connector.defaultIntervalSeconds ?? 60,
      tags: (asset?.tags ?? []).join(", "),
      connectionId: asset?.connectionId ?? "",
      enabled: asset?.enabled ?? true,
      config: buildDefaultConfig(connector, asset),
      customerId: asset?.customerId ?? "",
    },
    onSubmit: async ({ value }) => {
      setError(null);
      const payload = {
        name: value.name,
        target: value.target,
        intervalSeconds: Number(value.intervalSeconds),
        tags: value.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        connectionId: value.connectionId || null,
        enabled: value.enabled,
        config: value.config,
        customerId: value.customerId || null,
      };
      try {
        if (asset) {
          await orpcClient.assets.update({ id: asset.id, ...payload });
        } else {
          await orpcClient.assets.create({ connectorId: connector.id, ...payload });
        }
        await queryClient.invalidateQueries({ queryKey: orpc.assets.key() });
        await navigate({ to: "/assets" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
      }
    },
  });

  async function runDiscover(connectionId: string) {
    if (!connectionId) return;
    setDiscoverError(null);
    setDiscovering(true);
    try {
      const zones = await orpcClient.assets.discover({ connectorId: connector.id, connectionId });
      setDiscovered(zones);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : "Erkennung fehlgeschlagen");
    } finally {
      setDiscovering(false);
    }
  }

  const targetHint =
    connector.id === "http"
      ? "https://example.com"
      : connector.id === "aws"
        ? "* für das gesamte AWS-Konto"
        : connector.id === "mailcow"
          ? "https://mail.example.com"
          : connector.id === "wordpress"
            ? "https://blog.example.com"
            : "Kennung";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-5"
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Marketing-Website"
              required
            />
          </div>
        )}
      </form.Field>

      {needsConnection && (
        <form.Field name="connectionId">
          {(field) => (
            <div className="space-y-2">
              <Label>Verbindung</Label>
              <Select
                value={field.state.value}
                onValueChange={(v) => {
                  field.handleChange(v);
                  setDiscovered(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Zugangsdaten wählen" />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {connections.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Noch keine Zugangsdaten. Lege zuerst unter Verbindungen welche an.
                </p>
              )}

              {connector.capabilities.inventory && (
                <div className="space-y-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!field.state.value || discovering}
                    onClick={() => runDiscover(field.state.value)}
                  >
                    <Search />
                    {discovering ? "Erkenne…" : `Aus ${connector.name} erkennen`}
                  </Button>
                  {discoverError && <p className="text-xs text-destructive">{discoverError}</p>}
                  {discovered && discovered.length > 0 && (
                    <Select
                      onValueChange={(target) => {
                        const zone = discovered.find((z) => z.target === target);
                        if (!zone) return;
                        form.setFieldValue("target", zone.target);
                        if (!form.state.values.name) form.setFieldValue("name", zone.name);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={`${discovered.length} gefunden, bitte wählen`} />
                      </SelectTrigger>
                      <SelectContent>
                        {discovered.map((z) => (
                          <SelectItem key={z.target} value={z.target}>
                            {z.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {discovered && discovered.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Für diese Verbindung wurde nichts gefunden.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Listet verfügbare Ziele über die gewählten Zugangsdaten auf, damit du keine rohe
                    ID brauchst.
                  </p>
                </div>
              )}
            </div>
          )}
        </form.Field>
      )}

      <form.Field name="target">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="target">Ziel</Label>
            <Input
              id="target"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder={targetHint}
              required
            />
            {connector.id === "aws" && (
              <p className="text-xs text-muted-foreground">
                Hier <span className="font-mono">*</span> stehen lassen. Eine Prüfung deckt das
                ganze AWS-Konto ab. Welche Dienste abgefragt werden, wählst du unten.
              </p>
            )}
          </div>
        )}
      </form.Field>

      {connector.configFields.length > 0 && (
        <div className="space-y-5 rounded-lg border border-border p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Einstellungen für {connector.name}
          </div>
          {connector.configFields.map((fieldDesc) => (
            <form.Field key={fieldDesc.key} name={`config.${fieldDesc.key}`}>
              {(field) => (
                <ConfigField
                  descriptor={fieldDesc}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </form.Field>
          ))}
        </div>
      )}

      <form.Field name="customerId">
        {(field) => (
          <div className="space-y-2">
            <Label>Kunde</Label>
            <Select
              value={field.state.value || "none"}
              onValueChange={(v) => field.handleChange(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Kein Kunde" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Kein Kunde</SelectItem>
                {customers.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Setzt diese Prüfung auf die Karte. Kunden verwaltest du unter Kunden, dort kannst du
              auch viele Prüfungen auf einmal zuordnen.
            </p>
          </div>
        )}
      </form.Field>

      <div className="grid grid-cols-2 gap-4">
        <form.Field name="intervalSeconds">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="interval">Prüfintervall (Sekunden)</Label>
              <Input
                id="interval"
                type="number"
                min={5}
                value={field.state.value}
                onChange={(e) => field.handleChange(Number(e.target.value))}
              />
            </div>
          )}
        </form.Field>
        <form.Field name="tags">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="tags">Schlagwörter</Label>
              <Input
                id="tags"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="prod, öffentlich"
              />
            </div>
          )}
        </form.Field>
      </div>

      <form.Field name="enabled">
        {(field) => (
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <div className="text-sm font-medium">Aktiv</div>
              <div className="text-xs text-muted-foreground">
                Geplante Prüfungen für dieses Ziel ausführen.
              </div>
            </div>
            <Switch checked={field.state.value} onCheckedChange={field.handleChange} />
          </div>
        )}
      </form.Field>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Speichere…" : asset ? "Änderungen speichern" : "Prüfung anlegen"}
            </Button>
          )}
        </form.Subscribe>
        <Button type="button" variant="outline" onClick={() => navigate({ to: "/assets" })}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

function ConfigField({
  descriptor,
  value,
  onChange,
}: {
  descriptor: FieldDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (descriptor.type === "boolean") {
    return (
      <div className="flex items-center justify-between">
        <Label>{descriptor.label}</Label>
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
      </div>
    );
  }
  if (descriptor.type === "select") {
    return (
      <div className="space-y-2">
        <Label>{descriptor.label}</Label>
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder={descriptor.placeholder ?? "Auswählen"} />
          </SelectTrigger>
          <SelectContent>
            {descriptor.options?.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  const isNumber = descriptor.type === "number";
  return (
    <div className="space-y-2">
      <Label>{descriptor.label}</Label>
      <Input
        type={isNumber ? "number" : "text"}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(isNumber ? Number(e.target.value) : e.target.value)}
        placeholder={descriptor.placeholder}
      />
    </div>
  );
}
