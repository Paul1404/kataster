import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { SetupGuide } from "@/components/setup-guide";
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
import { orpc, orpcClient } from "@/lib/orpc";

export interface ConnectionRecord {
  id: string;
  name: string;
  connectorId: string;
  connectorName: string;
}

export function ConnectionForm({ connection }: { connection?: ConnectionRecord }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: connectors } = useQuery(orpc.connectors.list.queryOptions());

  const credentialed = (connectors ?? []).filter((c) => c.secretFields.length > 0);
  const editing = Boolean(connection);

  const [connectorId, setConnectorId] = useState(connection?.connectorId ?? "");
  const [name, setName] = useState(connection?.name ?? "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selected = credentialed.find((c) => c.id === connectorId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) return;

    const filled = selected.secretFields.filter((f) => (secrets[f.key] ?? "").trim() !== "");
    let secretsPayload: Record<string, string> | undefined = secrets;
    if (editing) {
      if (filled.length === 0) {
        secretsPayload = undefined; // keep the saved credentials
      } else {
        const missing = selected.secretFields.filter(
          (f) => f.required && !(secrets[f.key] ?? "").trim(),
        );
        if (missing.length > 0) {
          setError(
            "Zum Ändern der Zugangsdaten alle Felder ausfüllen. Sie ersetzen die gespeicherten vollständig.",
          );
          return;
        }
      }
    }

    setPending(true);
    try {
      if (editing && connection) {
        await orpcClient.connections.update({ id: connection.id, name, secrets: secretsPayload });
      } else {
        await orpcClient.connections.create({ name, connectorId, secrets });
      }
      await queryClient.invalidateQueries({ queryKey: orpc.connections.key() });
      await navigate({ to: "/connections" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-5 p-8">
      {editing ? (
        <div className="space-y-1">
          <Label>Connector</Label>
          <div className="text-sm text-muted-foreground">{connection?.connectorName}</div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Connector</Label>
          <Select
            value={connectorId}
            onValueChange={(v) => {
              setConnectorId(v);
              setSecrets({});
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Connector wählen" />
            </SelectTrigger>
            <SelectContent>
              {credentialed.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Hier erscheinen nur Connectoren, die Zugangsdaten brauchen. Connectoren ohne
            Zugangsdaten (wie HTTP und WordPress) legst du direkt unter Prüfungen an.
          </p>
        </div>
      )}

      {selected?.setup && (
        <SetupGuide setup={selected.setup} title={`${selected.name} einrichten`} />
      )}

      {selected && (
        <>
          <div className="space-y-2">
            <Label htmlFor="conn-name">Name</Label>
            <Input
              id="conn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${selected.name} (Produktion)`}
              required
            />
          </div>

          <div className="space-y-4 rounded-lg border border-border p-4">
            {editing && (
              <p className="text-xs text-muted-foreground">
                Felder leer lassen, um die gespeicherten Zugangsdaten zu behalten. Zum Ändern alle
                Felder ausfüllen. Sie ersetzen die gespeicherten Werte.
              </p>
            )}
            {selected.secretFields.map((f) => {
              const isUrl = f.type === "url";
              const visible = isUrl || reveal[f.key];
              return (
                <div key={f.key} className="space-y-2">
                  <Label>{f.label}</Label>
                  <div className="relative">
                    <Input
                      type={visible ? "text" : "password"}
                      autoComplete="off"
                      className={isUrl ? undefined : "pr-9"}
                      value={secrets[f.key] ?? ""}
                      onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={editing ? "unverändert" : f.placeholder}
                      required={!editing && f.required}
                    />
                    {!isUrl && (
                      <button
                        type="button"
                        onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={visible ? "Verbergen" : "Anzeigen"}
                        tabIndex={-1}
                      >
                        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!selected || pending}>
          {pending ? "Speichere…" : editing ? "Änderungen speichern" : "Verbindung anlegen"}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate({ to: "/connections" })}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}
