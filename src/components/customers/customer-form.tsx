import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { CustomerKind } from "@/lib/customer";
import { KIND_LABEL } from "@/lib/customer";
import { orpc, orpcClient } from "@/lib/orpc";
import { ContactsEditor } from "./contacts-editor";

export type CustomerStatus = "active" | "prospect" | "churned";

export interface CustomerRecord {
  id: string;
  name: string;
  kind: CustomerKind;
  status: CustomerStatus;
  tags: string[];
  notes: string | null;
  address: string | null;
  customerNumber: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  vatId: string | null;
  latitude: number | null;
  longitude: number | null;
}

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: "Aktiv",
  prospect: "Interessent",
  churned: "Abgewandert",
};

const KIND_OPTIONS = Object.keys(KIND_LABEL) as CustomerKind[];

export function CustomerForm({
  location,
  onDone,
  onCancel,
}: {
  location?: CustomerRecord;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState<CustomerKind>(location?.kind ?? "customer_business");
  const [status, setStatus] = useState<CustomerStatus>(location?.status ?? "active");
  const [tags, setTags] = useState((location?.tags ?? []).join(", "));
  const [notes, setNotes] = useState(location?.notes ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [customerNumber, setCustomerNumber] = useState(location?.customerNumber ?? "");
  const [billingEmail, setBillingEmail] = useState(location?.billingEmail ?? "");
  const [billingAddress, setBillingAddress] = useState(location?.billingAddress ?? "");
  const [vatId, setVatId] = useState(location?.vatId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) return setError("Name ist erforderlich.");
    setError(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        kind,
        status,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        notes: notes.trim() || null,
        address: address.trim() || null,
        customerNumber: customerNumber.trim() || null,
        billingEmail: billingEmail.trim() || null,
        billingAddress: billingAddress.trim() || null,
        vatId: vatId.trim() || null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
      };
      if (location) await orpcClient.customers.update({ id: location.id, ...payload });
      else await orpcClient.customers.create(payload);
      await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.customers.key() })]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div className="text-sm font-medium">{location ? "Kunde bearbeiten" : "Neuer Kunde"}</div>

      <div className="space-y-2">
        <Label htmlFor="loc-address">Adresse</Label>
        <Input
          id="loc-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Straße, Hausnummer, Postleitzahl und Ort"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="loc-name">Name</Label>
        <Input
          id="loc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Musterfirma GmbH"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Art</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as CustomerKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as CustomerStatus)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABEL) as CustomerStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="loc-tags">Schlagwörter</Label>
        <Input
          id="loc-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="vip, hosting, verein"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="loc-notes">Notizen</Label>
        <Textarea
          id="loc-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Alles, was zu diesem Kunden wichtig ist."
          rows={3}
        />
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Rechnungsdaten
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="loc-number">Kundennummer</Label>
            <Input
              id="loc-number"
              value={customerNumber}
              onChange={(e) => setCustomerNumber(e.target.value)}
              placeholder="K-1001"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="loc-vat">USt-IdNr.</Label>
            <Input
              id="loc-vat"
              value={vatId}
              onChange={(e) => setVatId(e.target.value)}
              placeholder="DE123456789"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="loc-billing-email">Rechnungs-E-Mail</Label>
          <Input
            id="loc-billing-email"
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
            placeholder="buchhaltung@beispiel.de"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="loc-billing-address">Rechnungsadresse</Label>
          <Textarea
            id="loc-billing-address"
            value={billingAddress}
            onChange={(e) => setBillingAddress(e.target.value)}
            placeholder="Falls abweichend von der Adresse oben."
            rows={2}
          />
        </div>
      </div>

      {location && <ContactsEditor customerId={location.id} />}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="button" onClick={handleSubmit} disabled={saving}>
          {saving ? "Speichere…" : location ? "Änderungen speichern" : "Kunde anlegen"}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
      </div>
    </Card>
  );
}
