import * as v from "valibot";
import {
  createChannel,
  deleteChannel,
  listChannels,
  listDeliveries,
  listRules,
  sendTestMessage,
  setChannelEnabled,
  updateRule,
} from "../../notifications/channels";
import { runNotificationDigest } from "../../notifications/digest";
import { authed } from "../base";

export const notificationsRouter = {
  // Webhook targets. The URL is encrypted at rest and only ever returned masked.
  channels: {
    list: authed.handler(() => listChannels()),
    create: authed
      .input(
        v.object({
          name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
          url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
        }),
      )
      .handler(({ input }) => createChannel(input)),
    setEnabled: authed
      .input(v.object({ id: v.string(), enabled: v.boolean() }))
      .handler(({ input }) => setChannelEnabled(input.id, input.enabled)),
    remove: authed.input(v.object({ id: v.string() })).handler(({ input }) => {
      return deleteChannel(input.id);
    }),
    test: authed
      .input(v.object({ id: v.string() }))
      .handler(({ input }) => sendTestMessage(input.id)),
  },
  rules: {
    list: authed.handler(() => listRules()),
    update: authed
      .input(
        v.object({
          id: v.string(),
          enabled: v.optional(v.boolean()),
          thresholdDays: v.optional(
            v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365))),
          ),
        }),
      )
      .handler(({ input }) => updateRule(input)),
  },
  deliveries: {
    list: authed
      .input(v.optional(v.object({ limit: v.optional(v.number()) }), {}))
      .handler(({ input }) => listDeliveries(input?.limit ?? 20)),
  },
  // Manual run of the daily digest, for when the operator does not want to wait.
  runDigest: authed.handler(() => runNotificationDigest()),
};
