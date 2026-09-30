import { ensureBaseUrl } from "../connectors/url";

// A normalized rspamd-history record. rspamd field names drift across versions
// (message-id vs message_id, unix_time vs time, rcpt_smtp vs rcpt_mime, sender_smtp
// vs sender_mime), so parsing is deliberately defensive.
export interface RspamdRecord {
  messageId: string;
  sender: string;
  recipients: string[];
  /** SASL-authenticated submission user. Present => the message was sent by us. */
  user: string | null;
  action: string | null;
  score: number | null;
  sizeBytes: number | null;
  /** Real event time in ms since epoch (from rspamd unix_time). */
  occurredAtMs: number;
}

function str(val: unknown): string {
  return typeof val === "string" ? val : val == null ? "" : String(val);
}

function numOrNull(val: unknown): number | null {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v).trim();
    if (s) return s;
  }
  return "";
}

// rcpt fields may be an array, a comma string, or absent depending on version.
function toRecipients(...vals: unknown[]): string[] {
  for (const v of vals) {
    if (Array.isArray(v)) {
      const list = v.map((x) => str(x).trim()).filter(Boolean);
      if (list.length > 0) return list;
    } else if (typeof v === "string" && v.trim()) {
      return v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseRecord(row: Record<string, unknown>): RspamdRecord | null {
  const messageId = firstString(row["message-id"], row.message_id, row.messageid);
  if (!messageId || messageId === "undef") return null;

  const unixTime = numOrNull(row.unix_time ?? row.time);
  // rspamd uses fractional seconds; fall back to "now" when missing so a record is
  // never silently dropped (ingest still dedups on message id).
  const occurredAtMs = unixTime != null ? Math.round(unixTime * 1000) : Date.now();

  const userRaw = firstString(row.user);
  return {
    messageId,
    sender: firstString(row.sender_smtp, row.sender_mime, row.from),
    recipients: toRecipients(row.rcpt_smtp, row.rcpt_mime, row.rcpt),
    user: userRaw && userRaw !== "undef" && userRaw !== "unknown" ? userRaw : null,
    action: firstString(row.action) || null,
    score: numOrNull(row.score),
    sizeBytes: numOrNull(row.size),
    occurredAtMs,
  };
}

/**
 * Fetch and normalize recent messages from a mailcow server's rspamd history.
 * Read-only, X-API-Key auth, same shape as the mailcow connector's getJson.
 * Returns [] on any error so a transient hiccup never throws into the poll loop.
 */
export async function fetchRspamdHistory(
  target: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<RspamdRecord[]> {
  const base = ensureBaseUrl(target);
  try {
    const res = await fetch(`${base}/api/v1/get/logs/rspamd-history`, {
      headers: { "X-API-Key": apiKey, accept: "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data: unknown = await res.json().catch(() => null);
    if (data && typeof data === "object" && (data as { type?: string }).type === "error") {
      return [];
    }
    // mailcow returns either a bare array or { rows: [...] } depending on version.
    const rows: unknown = Array.isArray(data) ? data : ((data as { rows?: unknown })?.rows ?? null);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map(parseRecord)
      .filter((r): r is RspamdRecord => r !== null);
  } catch {
    return [];
  }
}
