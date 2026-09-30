import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orpc, orpcClient } from "@/lib/orpc";

// Contacts (people) for a location. Add/remove inline; the list refetches itself.
export function ContactsEditor({ customerId }: { customerId: string }) {
  const queryClient = useQueryClient();
  const contactsQuery = useQuery(
    orpc.customers.contacts.list.queryOptions({ input: { customerId } }),
  );
  const contacts = contactsQuery.data ?? [];

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);

  async function invalidate() {
    await queryClient.invalidateQueries({
      queryKey: orpc.customers.contacts.list.key({ input: { customerId } }),
    });
  }

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await orpcClient.customers.contacts.upsert({
        customerId,
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        role: role.trim() || null,
      });
      setName("");
      setEmail("");
      setPhone("");
      setRole("");
      await invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await orpcClient.customers.contacts.remove({ id });
    await invalidate();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <Label>Kontakte</Label>

      {contacts.length > 0 && (
        <div className="space-y-1">
          {contacts.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium">
                  {c.isPrimary && <Star className="size-3.5 text-status-degraded" />}
                  <span className="truncate">{c.name}</span>
                  {c.role && <span className="text-xs text-muted-foreground">· {c.role}</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[c.email, c.phone].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(c.id)}
                className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                aria-label="Kontakt entfernen"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Rolle" />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" />
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Telefon" />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        disabled={busy || !name.trim()}
      >
        <Plus className="size-4" />
        Kontakt hinzufügen
      </Button>
    </div>
  );
}
