import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { NotificationSettings } from "@/components/notifications/notification-settings";
import { PageHeader } from "@/components/page-header";
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
import { relativeTime } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Einstellungen"
        description="Benachrichtigungen, Zugriffstoken und Integrationen."
      />
      <div className="space-y-8 p-8">
        <NotificationSettings />
        <McpTokens />
        <McpAuditLog />
      </div>
    </div>
  );
}

function McpAuditLog() {
  const query = useQuery(orpc.mcp.audit.list.queryOptions({ refetchInterval: 30_000 }));
  const entries = query.data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">MCP-Schreibprotokoll</h2>
      </div>
      <Card className="space-y-1 p-3">
        {query.isError ? (
          <div className="p-2 text-xs text-red-500">
            Das MCP-Protokoll konnte nicht geladen werden. Bitte erneut versuchen.
          </div>
        ) : entries.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">
            Noch keine MCP-Schreibversuche protokolliert.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{entry.toolName}</span>
              <span className="truncate text-xs text-muted-foreground">{entry.tokenName}</span>
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {entry.phase === "attempt"
                  ? "versucht"
                  : entry.success
                    ? "erfolgreich"
                    : "fehlgeschlagen"}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {relativeTime(entry.createdAt)}
              </span>
            </div>
          ))
        )}
      </Card>
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="Kopieren"
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </Button>
  );
}

function McpTokens() {
  const qc = useQueryClient();
  const tokensQuery = useQuery(orpc.mcp.tokens.list.queryOptions());
  const tokens = tokensQuery.data ?? [];

  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp";

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await orpcClient.mcp.tokens.create({ name: name.trim(), access });
      setFresh(res.token);
      setName("");
      await qc.invalidateQueries({ queryKey: orpc.mcp.tokens.key() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Token konnte nicht erstellt werden");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Token widerrufen? Alles, was ihn nutzt, funktioniert danach nicht mehr.")) return;
    try {
      await orpcClient.mcp.tokens.revoke({ id });
      await qc.invalidateQueries({ queryKey: orpc.mcp.tokens.key() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Token konnte nicht widerrufen werden");
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">MCP-Zugriffstoken</h2>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Token sind standardmäßig nur lesend. Schreibzugriff nur für Agenten vergeben, die
        Zuordnungen oder Finanzdaten ändern müssen. Jeder Schreibversuch landet im Protokoll.
        Verbinden mit:
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          claude mcp add kataster --transport http {endpoint} --header "Authorization: Bearer
          &lt;token&gt;"
        </code>
        <CopyButton
          value={`claude mcp add kataster --transport http ${endpoint} --header "Authorization: Bearer <token>"`}
        />
      </div>

      {fresh && (
        <Card className="space-y-2 border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="text-sm font-medium">
            Neuer Token. Jetzt kopieren, er wird nur einmal angezeigt.
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-3 py-2 text-xs">
              {fresh}
            </code>
            <CopyButton value={fresh} />
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setFresh(null)}
          >
            Fertig
          </button>
        </Card>
      )}

      <Card className="space-y-1 p-3">
        {tokensQuery.isError ? (
          <div className="p-2 text-xs text-red-500">
            Token konnten nicht geladen werden. Bitte erneut versuchen.
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">Noch keine Token.</div>
        ) : (
          tokens.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.scopes.includes("write") ? "Lesen + Schreiben" : "Nur Lesen"}
              </span>
              <code className="shrink-0 text-xs text-muted-foreground">{t.tokenPrefix}</code>
              <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground sm:block">
                {t.lastUsedAt ? `genutzt ${relativeTime(t.lastUsedAt)}` : "nie genutzt"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => revoke(t.id)}
                aria-label="Token widerrufen"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))
        )}
        <div className="flex items-center gap-2 pt-2">
          <Input
            placeholder="Token-Name (z. B. claude-code)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            className="flex-1"
          />
          <Select value={access} onValueChange={(value) => setAccess(value as "read" | "write")}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">Nur Lesen</SelectItem>
              <SelectItem value="write">Lesen + Schreiben</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={busy || !name.trim()} onClick={create}>
            <Plus className="size-4" />
            Erzeugen
          </Button>
        </div>
      </Card>
    </section>
  );
}
