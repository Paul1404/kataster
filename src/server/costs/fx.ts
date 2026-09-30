// Kataster reports cost in a single currency (EUR), so pools from USD providers (AWS,
// Railway) are converted to EUR at ingest. This is a manually-maintained fixed
// rate, not a live feed: update it when the EUR/USD spread drifts enough to
// matter. As of 2026-07, roughly 0.92 EUR per USD.
export const USD_TO_EUR = 0.92;

// Convert a cent amount in `currency` to EUR cents. EUR passes through unchanged;
// unknown currencies are assumed already EUR rather than dropped.
export function toEurCents(amountCents: number, currency: string): number {
  if (currency === "USD") return Math.round(amountCents * USD_TO_EUR);
  return amountCents;
}
