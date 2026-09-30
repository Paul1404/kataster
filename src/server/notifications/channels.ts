/**
 * Channel bookkeeping. The webhook URL is encrypted at rest with the same
 * AES-256-GCM envelope as connector credentials and is never returned over the
 * wire; the UI sees only the stored preview (host plus last four characters).
 *
 * Server-only.
 */
import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { encryptSecret } from "../crypto/secrets";
import { db } from "../db";
import {
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../db/schema/notifications";
import { deliverEvent } from "./deliver";
import type { NotificationEvent } from "./events";
import { RULE_DEFAULTS, RULE_KINDS } from "./rules";

export interface MaskedChannel {
  id: string;
  name: string;
  kind: "webhook";
  targetPreview: string;
  enabled: boolean;
  createdAt: Date;
}

/** "ntfy.sh ...ab12". Enough to recognise the target, useless to an onlooker. */
export function maskTargetUrl(raw: string): string {
  let host = "unbekannt";
  try {
    host = new URL(raw).host;
  } catch {
    host = "unbekannt";
  }
  const last4 = raw.slice(-4);
  return `${host} ...${last4}`;
}

function requireHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ORPCError("VALIDATION_FAILED", { message: "Keine gültige URL" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ORPCError("VALIDATION_FAILED", { message: "Nur http- oder https-URLs sind erlaubt" });
  }
  return parsed.toString();
}

function mask(row: typeof notificationChannels.$inferSelect): MaskedChannel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    targetPreview: row.targetPreview,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export async function listChannels(): Promise<MaskedChannel[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.name);
  return rows.map(mask);
}

/** Create a channel and seed one rule per kind, so the UI has toggles at once. */
export async function createChannel(input: { name: string; url: string }): Promise<MaskedChannel> {
  const url = requireHttpUrl(input.url);
  const [row] = await db
    .insert(notificationChannels)
    .values({
      name: input.name.trim(),
      kind: "webhook",
      target: encryptSecret({ url }),
      targetPreview: maskTargetUrl(url),
    })
    .returning();
  if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Kanal nicht angelegt" });

  await db.insert(notificationRules).values(
    RULE_KINDS.map((kind) => ({
      channelId: row.id,
      kind,
      enabled: RULE_DEFAULTS[kind].enabled,
      thresholdDays: RULE_DEFAULTS[kind].thresholdDays,
    })),
  );
  return mask(row);
}

export async function setChannelEnabled(id: string, enabled: boolean): Promise<MaskedChannel> {
  const [row] = await db
    .update(notificationChannels)
    .set({ enabled })
    .where(eq(notificationChannels.id, id))
    .returning();
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Kanal nicht gefunden" });
  return mask(row);
}

export async function deleteChannel(id: string): Promise<void> {
  await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
}

export async function listRules() {
  return db
    .select()
    .from(notificationRules)
    .orderBy(notificationRules.channelId, notificationRules.kind);
}

export async function updateRule(input: {
  id: string;
  enabled?: boolean;
  thresholdDays?: number | null;
}) {
  const patch: Partial<typeof notificationRules.$inferInsert> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.thresholdDays !== undefined) patch.thresholdDays = input.thresholdDays;
  const [row] = await db
    .update(notificationRules)
    .set(patch)
    .where(eq(notificationRules.id, input.id))
    .returning();
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Regel nicht gefunden" });
  return row;
}

export async function listDeliveries(limit = 20) {
  return db
    .select({
      id: notificationDeliveries.id,
      channelId: notificationDeliveries.channelId,
      channelName: notificationChannels.name,
      ruleKind: notificationDeliveries.ruleKind,
      title: notificationDeliveries.title,
      body: notificationDeliveries.body,
      status: notificationDeliveries.status,
      error: notificationDeliveries.error,
      createdAt: notificationDeliveries.createdAt,
    })
    .from(notificationDeliveries)
    .leftJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit);
}

/**
 * Send a one-off test message. Its dedupe key carries a timestamp, so the
 * button stays pressable while real events remain deduped.
 */
export async function sendTestMessage(channelId: string): Promise<{ ok: boolean; error?: string }> {
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId));
  if (!channel) throw new ORPCError("NOT_FOUND", { message: "Kanal nicht gefunden" });

  const event: NotificationEvent = {
    channelId,
    ruleKind: "incident_opened",
    dedupeKey: `${channelId}:test:${Date.now()}`,
    title: "Kataster Testnachricht",
    body: `Der Kanal "${channel.name}" ist eingerichtet. Echte Meldungen sehen genauso aus.`,
  };
  const outcome = await deliverEvent(event);
  if (outcome.status === "sent") return { ok: true };
  if (outcome.status === "skipped") return { ok: false, error: "Kanal ist deaktiviert" };
  return { ok: false, error: outcome.error ?? "Zustellung fehlgeschlagen" };
}
