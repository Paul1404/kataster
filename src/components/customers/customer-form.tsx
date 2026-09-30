import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import type { CustomerKind } from "@/components/map/infra-map";
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
  const [lat, setLat] = useState(location?.latitude != null ? String(location.latitude) : "");
  const [lng, setLng] = useState(location?.longitude != null ? String(location.longitude) : "");
  const [customerNumber, setCustomerNumber] = useState(location?.customerNumber ?? "");
  const [billingEmail, setBillingEmail] = useState(location?.billingEmail ?? "");
  const [billingAddress, setBillingAddress] = useState(location?.billingAddress ?? "");
  const [vatId, setVatId] = useState(location?.vatId ?? "");
  const [geoResults, setGeoResults] = useState<
    { label: string; latitude: number; longitude: number }[] | null
  >(null);
  const [geocoding, setGeocoding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function runGeocode() {
    if (!address.trim()) return;
    setError(null);
    setGeocoding(true);
    try {
      const results = await orpcClient.assets.geocode({ query: address });
      setGeoResults(results);
      if (results.length === 0) setError("Keine Treffer für diese Adresse.");
      else if (!name.trim()) setName(address.split(",")[0]!.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suche fehlgeschlagen");
    } finally {
      setGeocoding(false);
    }
  }

  async function handleSubmit() {
    const hasCoords = lat.trim() !== "" || lng.trim() !== "";
    const latitude = hasCoords ? Number(lat) : null;
    const longitude = hasCoords ? Number(lng) : null;
    if (!name.trim()) return setError("Name ist erforderlich.");
    if (hasCoords && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
      return setError("Beide Koordinaten angeben oder beide leer lassen.");
    }
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
        latitude,
        longitude,
      };
      if (location) await orpcClient.customers.update({ id: location.id, ...payload });
      else await orpcClient.customers.create(payload);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.customers.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboard.map.key() }),
      ]);
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
        <div className="flex gap-2">
          <Input
            id="loc-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Frankfurt am Main"
          />
          <Button
            type="button"
            variant="outline"
            disabled={!address.trim() || geocoding}
            onClick={runGeocode}
          >
            <Search />
            {geocoding ? "Suche…" : "Suchen"}
          </Button>
        </div>
        {geoResults && geoResults.length > 0 && (
          <Select
            onValueChange={(value) => {
              const pick = geoResults[Number(value)];
              if (!pick) return;
              setLat(String(pick.latitude));
              setLng(String(pick.longitude));
              setAddress(pick.label);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={`${geoResults.length} Treffer, bitte wählen`} />
            </SelectTrigger>
            <SelectContent>
              {geoResults.map((r, i) => (
                <SelectItem key={`${r.latitude},${r.longitude}`} value={String(i)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Kartenposition (optional)
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="loc-lat">Breitengrad</Label>
            <Input
              id="loc-lat"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="50.11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="loc-lng">Längengrad</Label>
            <Input
              id="loc-lng"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="8.68"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Wird über Suchen aus der Adresse gefüllt. Ohne Koordinaten erscheint der Kunde nicht auf
          der Karte, alles andere funktioniert trotzdem.
        </p>
      </details>

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
