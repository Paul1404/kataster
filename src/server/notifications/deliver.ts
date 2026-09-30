/**
 * Webhook delivery. Server-only.
 *
 * Payload shape: one JSON body that three common receivers understand at once,
 * so the operator can paste an ntfy, a Slack or a Discord URL into the same
 * field and it just works.
 *   - ntfy    reads `title` and `message` (the X-Title header also carries the
 *             title, so a raw ntfy topic URL shows a proper heading)
 *   - Slack   reads `text` (incoming webhooks)
 *   - Discord reads `content` (webhooks)
 * `title`, `text`, `content` and `message` are therefore always all present;
 * `text` and `content` carry the title and body together, `message` the body.
 *
 * Dedupe: the delivery row is inserted BEFORE the request goes out, using the
 * unique `dedupe_key`. If the insert conflicts, the event was already handled
 * and nothing is sent. A request that fails is recorded as `failed` and its key
 * is released (suffixed), so the next digest may retry while the failed attempt
 * stays visible in the UI.
 *
 * Nothing in here throws at the caller: the worker loop must never die over a
 * broken webhook.
 */
import { eq } from "drizzle-orm";
import { decryptSecret } from "../crypto/secrets";
import { db } from "../db";
import { notificationChannels, notificationDeliveries } from "../db/schema/notifications";
import type { NotificationEvent } from "./events";

const TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS ?? 8000);

export interface WebhookPayload {
  title: string;
  text: string;
  content: string;
  message: string;
  ruleKind: string;
  dedupeKey: string;
  sentAt: string;
}

/** The one body shape sent to every webhook target. Pure, so it is testable. */
export function buildWebhookPayload(event: NotificationEvent, sentAt: Date): WebhookPayload {
  const combined = `${event.title}\n${event.body}`;
  return {
    title: event.title,
    text: combined,
    content: combined,
    message: event.body,
    ruleKind: event.ruleKind,
    dedupeKey: event.dedupeKey,
    sentAt: sentAt.toISOString(),
  };
}

/** Read the encrypted target URL of a channel. Never leaves the server. */
export async function loadChannelTarget(encrypted: string): Promise<string> {
  const secret = decryptSecret<{ url?: string }>(encrypted);
  if (typeof secret.url !== "string" || !secret.url) throw new Error("channel has no target URL");
  return secret.url;
}

/** POST the payload. Throws on a timeout or a non-2xx response. */
export async function postWebhook(url: string, payload: WebhookPayload): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ntfy takes the title from a header when the body is JSON.
      "X-Title": payload.title.replace(/[\r\n]+/g, " ").slice(0, 200),
      "User-Agent": "kataster-notify/1",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`.trim());
  }
}

export interface DeliveryOutcome {
  dedupeKey: string;
  status: "sent" | "failed" | "duplicate" | "skipped";
  error?: string;
}

/**
 * Send one event to its channel, exactly once. Returns what happened instead of
 * throwing.
 */
export async function deliverEvent(event: NotificationEvent): Promise<DeliveryOutcome> {
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, event.channelId));
  if (!channel?.enabled) return { dedupeKey: event.dedupeKey, status: "skipped" };

  // Claim the event first: a conflict means someone already sent it.
  const claimed = await db
    .insert(notificationDeliveries)
    .values({
      channelId: channel.id,
      ruleKind: event.ruleKind,
      dedupeKey: event.dedupeKey,
      title: event.title,
      body: event.body,
      status: "sent",
    })
    .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
    .returning({ id: notificationDeliveries.id });
  const row = claimed[0];
  if (!row) return { dedupeKey: event.dedupeKey, status: "duplicate" };

  try {
    const url = await loadChannelTarget(channel.target);
    await postWebhook(url, buildWebhookPayload(event, new Date()));
    return { dedupeKey: event.dedupeKey, status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep the failure visible, but release the key so a later run may retry.
    await db
      .update(notificationDeliveries)
      .set({
        status: "failed",
        error: message.slice(0, 500),
        dedupeKey: `${event.dedupeKey}:failed:${row.id}`,
      })
      .where(eq(notificationDeliveries.id, row.id))
      .catch(() => {});
    console.error("[notify] delivery failed", event.ruleKind, message);
    return { dedupeKey: event.dedupeKey, status: "failed", error: message };
  }
}

/** Send a list of events, one after another. Never throws. */
export async function deliverEvents(events: NotificationEvent[]): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  for (const event of events) {
    try {
      outcomes.push(await deliverEvent(event));
    } catch (error) {
      // deliverEvent already swallows send errors; this only catches DB trouble.
      console.error("[notify] delivery aborted", (error as Error)?.message);
      outcomes.push({
        dedupeKey: event.dedupeKey,
        status: "failed",
        error: (error as Error)?.message,
      });
    }
  }
  return outcomes;
}
