/**
 * Rule bookkeeping shared by the digest, the incident path and the oRPC router.
 * Server-only.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { notificationChannels, notificationRules } from "../db/schema/notifications";
import {
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  type NotificationRuleInput,
  type NotificationRuleKind,
} from "./events";

/** Every rule kind, in the order the settings page shows them. */
export const RULE_KINDS: NotificationRuleKind[] = [
  "incident_opened",
  "incident_resolved",
  "expiry_soon",
  "worker_down",
  "billing_incomplete",
];

/** Defaults a fresh channel starts with: outages loudly, money quietly. */
export const RULE_DEFAULTS: Record<
  NotificationRuleKind,
  { enabled: boolean; thresholdDays: number | null }
> = {
  incident_opened: { enabled: true, thresholdDays: null },
  incident_resolved: { enabled: true, thresholdDays: null },
  expiry_soon: { enabled: true, thresholdDays: DEFAULT_EXPIRY_THRESHOLD_DAYS },
  worker_down: { enabled: true, thresholdDays: null },
  billing_incomplete: { enabled: false, thresholdDays: null },
};

/**
 * Enabled rules of enabled channels, narrowed to the given kinds.
 * This is exactly the input the pure engine expects.
 */
export async function loadActiveRules(
  kinds: NotificationRuleKind[],
): Promise<NotificationRuleInput[]> {
  if (kinds.length === 0) return [];
  const rows = await db
    .select({
      channelId: notificationRules.channelId,
      kind: notificationRules.kind,
      thresholdDays: notificationRules.thresholdDays,
    })
    .from(notificationRules)
    .innerJoin(notificationChannels, eq(notificationRules.channelId, notificationChannels.id))
    .where(
      and(
        eq(notificationRules.enabled, true),
        eq(notificationChannels.enabled, true),
        inArray(notificationRules.kind, kinds),
      ),
    );
  return rows;
}
