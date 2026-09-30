// German (de-DE) formatting for the whole UI. Keep every user-visible number,
// currency and time string going through here so the app stays consistent.

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return "nie";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "gerade eben";
  if (seconds < 60) return `vor ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} h`;
  const days = Math.round(hours / 24);
  return `vor ${days} d`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "k. A.";
  return `${ms} ms`;
}

/** A check cadence: "alle 60 s", "alle 15 min", "alle 2 h". */
export function formatInterval(seconds: number): string {
  if (seconds < 120) return `alle ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `alle ${minutes} min`;
  return `alle ${Math.round(minutes / 60)} h`;
}

const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

const EURO_FORMAT = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Cents to a German euro string, e.g. 123456 -> "1.234,56 €". */
export function formatEuro(cents: number): string {
  return EURO_FORMAT.format(cents / 100);
}

/** Parse a German or English decimal string ("12,50" or "12.50") to cents. */
export function parseEuroToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, "").replace(/€/g, "");
  if (!normalized) return null;
  // "1.234,56" -> "1234.56"; "12.50" stays; "12,50" -> "12.50".
  const hasComma = normalized.includes(",");
  const cleaned = hasComma
    ? normalized.replace(/\./g, "").replace(",", ".")
    : normalized.replace(/,/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Cents to a plain editable decimal ("12,50") for inputs. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "k. A.";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${formatDecimal(value, value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDecimal(value: number, digits = 1): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const DATETIME_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "k. A.";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "k. A." : DATE_FORMAT.format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "k. A.";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "k. A." : DATETIME_FORMAT.format(d);
}

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

/** 'YYYY-MM' -> "September 2026". */
export function formatPeriod(period: string): string {
  const [y, m] = period.split("-");
  const idx = Number(m) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${y}` : period;
}

/** German-friendly labels for inventory resource types. */
export const RESOURCE_TYPE_LABEL: Record<string, string> = {
  domain: "Domain",
  registered_domain: "Registrierte Domain",
  dns_zone: "DNS-Zone",
  cloudfront_distribution: "CloudFront-Distribution",
  acm_cert: "Zertifikat",
  cert: "Zertifikat",
  ses_identity: "SES-Identität",
  ses_tenant: "SES-Mandant",
  mail_domain: "Mail-Domain",
  mailbox: "Postfach",
  container: "Container",
  host: "Host",
  vps: "VPS",
  railway_project: "Railway-Projekt",
  railway_service: "Railway-Service",
  asset: "Prüfung",
};

export function resourceTypeLabel(type: string): string {
  return RESOURCE_TYPE_LABEL[type] ?? type.replaceAll("_", " ");
}
