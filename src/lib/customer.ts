import type { CustomerKind } from "@/components/map/infra-map";

export const KIND_LABEL: Record<CustomerKind, string> = {
  provider: "Anbieter",
  customer_private: "Kunde (privat)",
  customer_business: "Kunde (gewerblich)",
  internal: "Intern",
  partner: "Partner",
};

/** Days until a date, or null if absent/invalid. Negative means overdue. */
export function daysUntil(value: string | Date | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

/** Expiry urgency colour: red <= 7d, amber <= 30d, muted otherwise. */
export function expiryColor(days: number | null): string {
  if (days === null) return "#64748b";
  if (days <= 7) return "#ef4444";
  if (days <= 30) return "#f59e0b";
  return "#94a3b8";
}
