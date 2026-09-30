import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, relativeTime } from "@/lib/format";
import { orpc, orpcClient } from "@/lib/orpc";

type RuleKind =
  | "incident_opened"
  | "incident_resolved"
  | "expiry_soon"
  | "worker_down"
  | "billing_incomplete";

const RULE_LABEL: Record<RuleKind, string> = {
  incident_opened: "Ausfall beginnt",
  incident_resolved: "Ausfall behoben",
  expiry_soon: "Domain oder Zertifikat läuft ab",
  worker_down: "Worker antwortet nicht",
  billing_incomplete: "Abrechnungsmonat unvollständig",
};

const RULE_HINT: Record<RuleKind, string> = {
  incident_opened: "sofort",
  incident_resolved: "sofort",
  expiry_soon: "täglich",
  worker_down: "täglich",
  billing_incomplete: "täglich",
};

const RULE_ORDER: RuleKind[] = [
  "incident_opened",
  "incident_resolved",
  "expiry_soon",
  "worker_down",
  "billing_incomplete",
];

export function NotificationSettings() {
  const qc = useQueryClient();
  const channelsQuery = useQuery(orpc.notifications.channels.list.queryOptions());
  const rulesQuery = useQuery(orpc.notifications.rules.list.queryOptions());
  const deliveriesQuery = useQuery(
    orpc.notifications.deliveries.list.queryOptions({ input: {}, refetchInterval: 30_000 }),
  );

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: orpc.notifications.channels.key() }),
      qc.invalidateQueries({ queryKey: orpc.notifications.rules.key() }),
      qc.invalidateQueries({ queryKey: orpc.notifications.deliveries.key() }),
    ]);
  }

  const createChannel = useMutation({
    mutationFn: () => orpcClient.notifications.channels.create({ name: name.trim(), url }),
    onSuccess: async () => {
      setName("");
      setUrl("");
      toast.success("Kanal angelegt");
      await refresh();
    },
    onError: (error: Error) => toast.error(error.message || "Kanal konnte nicht angelegt werden"),
  });

  const removeChannel = useMutation({
    mutationFn: (id: string) => orpcClient.notifications.channels.remove({ id }),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message || "Kanal konnte nicht gelöscht werden"),
  });

  const toggleChannel = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      orpcClient.notifications.channels.setEnabled(input),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message || "Kanal konnte nicht geändert werden"),
  });

  const updateRule = useMutation({
    mutationFn: (input: { id: string; enabled?: boolean; thresholdDays?: number | null }) =>
      orpcClient.notifications.rules.update(input),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message || "Regel konnte nicht geändert werden"),
  });

  const sendTest = useMutation({
    mutationFn: (id: string) => orpcClient.notifications.channels.test({ id }),
    onSuccess: async (result) => {
      if (result.ok) toast.success("Testnachricht gesendet");
      else toast.error(result.error ?? "Testnachricht fehlgeschlagen");
      await refresh();
    },
    onError: (error: Error) => toast.error(error.message || "Testnachricht fehlgeschlagen"),
  });

  const channels = channelsQuery.data ?? [];
  const rules = rulesQuery.data ?? [];
  const deliveries = deliveriesQuery.data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Bell className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Benachrichtigungen</h2>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Kataster schickt Meldungen an einen Webhook. Die Nachricht enthält gleichzeitig die Felder{" "}
        <code className="rounded bg-muted px-1">title</code>,{" "}
        <code className="rounded bg-muted px-1">message</code>,{" "}
        <code className="rounded bg-muted px-1">text</code> und{" "}
        <code className="rounded bg-muted px-1">content</code>, damit dieselbe URL für ntfy, Slack
        und Discord funktioniert. Ausfälle gehen sofort raus, alles andere einmal täglich. Die URL
        wird verschlüsselt gespeichert und danach nur noch maskiert angezeigt.
      </p>

      <Card className="space-y-2 p-3">
        {channelsQuery.isError ? (
          <div className="p-2 text-xs text-red-500">
            Kanäle konnten nicht geladen werden. Bitte erneut versuchen.
          </div>
        ) : channels.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">Noch kein Kanal eingerichtet.</div>
        ) : (
          channels.map((channel) => (
            <div key={channel.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{channel.name}</span>
                <code className="shrink-0 text-xs text-muted-foreground">
                  {channel.targetPreview}
                </code>
                <Switch
                  checked={channel.enabled}
                  onCheckedChange={(enabled) => toggleChannel.mutate({ id: channel.id, enabled })}
                  aria-label="Kanal aktiv"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sendTest.isPending}
                  onClick={() => sendTest.mutate(channel.id)}
                >
                  <Send className="size-4" />
                  Testnachricht senden
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Kanal löschen"
                  onClick={() => {
                    if (confirm(`Kanal "${channel.name}" löschen?`)) {
                      removeChannel.mutate(channel.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="space-y-1">
                {RULE_ORDER.map((kind) => {
                  const rule = rules.find((r) => r.channelId === channel.id && r.kind === kind);
                  if (!rule) return null;
                  return (
                    <div key={rule.id} className="flex items-center gap-3 px-1 py-1 text-sm">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(enabled) => updateRule.mutate({ id: rule.id, enabled })}
                        aria-label={RULE_LABEL[kind]}
                      />
                      <span className="min-w-0 flex-1 truncate">{RULE_LABEL[kind]}</span>
                      {kind === "expiry_soon" && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <label htmlFor={`threshold-${rule.id}`}>Vorlauf</label>
                          <Input
                            id={`threshold-${rule.id}`}
                            type="number"
                            min={1}
                            max={365}
                            className="h-8 w-20"
                            defaultValue={rule.thresholdDays ?? 30}
                            onBlur={(e) => {
                              const days = Number.parseInt(e.target.value, 10);
                              if (!Number.isFinite(days) || days < 1 || days > 365) return;
                              if (days === rule.thresholdDays) return;
                              updateRule.mutate({ id: rule.id, thresholdDays: days });
                            }}
                          />
                          <span>Tage</span>
                        </div>
                      )}
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {RULE_HINT[kind]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}

        <div className="flex items-center gap-2 pt-2">
          <Input
            placeholder="Kanalname (z. B. Handy)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56"
          />
          <Input
            placeholder="https://ntfy.sh/mein-topic"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1"
          />
          <Button
            disabled={createChannel.isPending || !name.trim() || !url.trim()}
            onClick={() => createChannel.mutate()}
          >
            <Plus className="size-4" />
            Hinzufügen
          </Button>
        </div>
      </Card>

      <div className="text-sm font-medium">Letzte Zustellungen</div>
      <Card className="space-y-1 p-3">
        {deliveriesQuery.isError ? (
          <div className="p-2 text-xs text-red-500">
            Zustellungen konnten nicht geladen werden. Bitte erneut versuchen.
          </div>
        ) : deliveries.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">Noch nichts verschickt.</div>
        ) : (
          deliveries.map((delivery) => (
            <div
              key={delivery.id}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
              title={formatDateTime(delivery.createdAt)}
            >
              <span
                className={
                  delivery.status === "sent"
                    ? "shrink-0 text-[10px] font-medium uppercase tracking-wide text-emerald-500"
                    : "shrink-0 text-[10px] font-medium uppercase tracking-wide text-red-500"
                }
              >
                {delivery.status === "sent" ? "gesendet" : "fehlgeschlagen"}
              </span>
              <span className="min-w-0 flex-1 truncate">{delivery.title}</span>
              <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block">
                {delivery.channelName ?? "unbekannt"}
              </span>
              {delivery.error && (
                <span className="hidden max-w-64 shrink-0 truncate text-xs text-red-500 md:block">
                  {delivery.error}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {relativeTime(delivery.createdAt)}
              </span>
            </div>
          ))
        )}
      </Card>
    </section>
  );
}
