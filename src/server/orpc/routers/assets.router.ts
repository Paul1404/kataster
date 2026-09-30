import { ORPCError } from "@orpc/server";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import * as v from "valibot";
import { loadConnectionSecret } from "../../connections/service";
import { getConnector } from "../../connectors/registry";
import type { AnyConnector, DiscoveredAsset } from "../../connectors/types";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { checksQueue } from "../../queue/checks.queue";
import {
  scheduleAsset,
  scheduleMailPoll,
  unscheduleAsset,
  unscheduleMailPoll,
} from "../../queue/schedule";
import { authed } from "../base";

// Mailcow assets also get a fast rspamd-history poll alongside their health check.
async function syncMailPoll(connectorId: string, assetId: string, enabled: boolean): Promise<void> {
  if (connectorId !== "mailcow") return;
  if (enabled) await scheduleMailPoll(assetId);
  else await unscheduleMailPoll(assetId);
}

function connectorOrThrow(id: string): AnyConnector {
  const connector = getConnector(id);
  if (!connector) {
    throw new ORPCError("NOT_FOUND", { message: `Unknown connector: ${id}` });
  }
  return connector;
}

function parseConfig(connector: AnyConnector, config: unknown): Record<string, unknown> {
  const result = v.safeParse(connector.configSchema, config ?? {});
  if (!result.success) {
    throw new ORPCError("VALIDATION_FAILED", {
      message: `Invalid config: ${result.issues.map((i) => i.message).join(", ")}`,
    });
  }
  return result.output as Record<string, unknown>;
}

const CreateInput = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  connectorId: v.pipe(v.string(), v.minLength(1)),
  target: v.pipe(v.string(), v.minLength(1)),
  config: v.optional(v.record(v.string(), v.unknown())),
  tags: v.optional(v.array(v.string())),
  connectionId: v.optional(v.nullable(v.string())),
  groupId: v.optional(v.nullable(v.string())),
  customerId: v.optional(v.nullable(v.string())),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(5))),
  enabled: v.optional(v.boolean()),
});

const UpdateInput = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  target: v.optional(v.string()),
  config: v.optional(v.record(v.string(), v.unknown())),
  tags: v.optional(v.array(v.string())),
  connectionId: v.optional(v.nullable(v.string())),
  groupId: v.optional(v.nullable(v.string())),
  customerId: v.optional(v.nullable(v.string())),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(5))),
  enabled: v.optional(v.boolean()),
});

export const assetsRouter = {
  list: authed.handler(async () => {
    // The latest result message says why a check is degraded or down; the list
    // shows it inline so the reason is visible without opening every row. The
    // outer column is spelled out: inside a select field Drizzle renders
    // ${assets.id} unqualified, which would bind to check_results.id instead.
    return db
      .select({
        ...getTableColumns(assets),
        lastMessage: sql<string | null>`(
          select cr.message from check_results cr
          where cr.asset_id = "assets"."id"
          order by cr.checked_at desc limit 1
        )`,
      })
      .from(assets)
      .orderBy(desc(assets.createdAt));
  }),

  get: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    const [row] = await db.select().from(assets).where(eq(assets.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Prüfung nicht gefunden" });
    return row;
  }),

  create: authed.input(CreateInput).handler(async ({ input }) => {
    const connector = connectorOrThrow(input.connectorId);
    const config = parseConfig(connector, input.config);

    const [row] = await db
      .insert(assets)
      .values({
        name: input.name,
        connectorId: input.connectorId,
        target: input.target,
        config,
        tags: input.tags ?? [],
        connectionId: input.connectionId ?? null,
        groupId: input.groupId ?? null,
        customerId: input.customerId ?? null,
        intervalSeconds: input.intervalSeconds ?? connector.defaultIntervalSeconds ?? 60,
        enabled: input.enabled ?? true,
      })
      .returning();

    if (row!.enabled) {
      await scheduleAsset(row!.id, row!.intervalSeconds);
    }
    await syncMailPoll(row!.connectorId, row!.id, row!.enabled);
    return row!;
  }),

  update: authed.input(UpdateInput).handler(async ({ input }) => {
    const [existing] = await db.select().from(assets).where(eq(assets.id, input.id));
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "Prüfung nicht gefunden" });

    const patch: Partial<typeof assets.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.target !== undefined) patch.target = input.target;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.connectionId !== undefined) patch.connectionId = input.connectionId;
    if (input.groupId !== undefined) patch.groupId = input.groupId;
    if (input.intervalSeconds !== undefined) patch.intervalSeconds = input.intervalSeconds;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.customerId !== undefined) patch.customerId = input.customerId;
    if (input.config !== undefined) {
      patch.config = parseConfig(connectorOrThrow(existing.connectorId), input.config);
    }

    const [row] = await db.update(assets).set(patch).where(eq(assets.id, input.id)).returning();

    if (row!.enabled) {
      await scheduleAsset(row!.id, row!.intervalSeconds);
    } else {
      await unscheduleAsset(row!.id);
    }
    await syncMailPoll(row!.connectorId, row!.id, row!.enabled);
    return row!;
  }),

  toggle: authed
    .input(v.object({ id: v.string(), enabled: v.boolean() }))
    .handler(async ({ input }) => {
      const [row] = await db
        .update(assets)
        .set({ enabled: input.enabled })
        .where(eq(assets.id, input.id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Prüfung nicht gefunden" });
      if (input.enabled) await scheduleAsset(row.id, row.intervalSeconds);
      else await unscheduleAsset(row.id);
      await syncMailPoll(row.connectorId, row.id, input.enabled);
      return row;
    }),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    await unscheduleAsset(input.id);
    await unscheduleMailPoll(input.id);
    await db.delete(assets).where(eq(assets.id, input.id));
    return { ok: true };
  }),

  // Enqueue an immediate one-off check (e.g. right after a fix), independent of
  // the asset's repeating schedule.
  runNow: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    const [row] = await db
      .select({ id: assets.id, connectorId: assets.connectorId })
      .from(assets)
      .where(eq(assets.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Prüfung nicht gefunden" });
    await checksQueue.add(
      "check",
      { assetId: row.id },
      { removeOnComplete: true, removeOnFail: true },
    );
    return { ok: true };
  }),

  // Mute an asset until a given time (or clear). While muted, checks still run but
  // no incidents open. Pass until=null to unmute.
  mute: authed
    .input(v.object({ id: v.string(), until: v.nullable(v.string()) }))
    .handler(async ({ input }) => {
      const mutedUntil = input.until ? new Date(input.until) : null;
      if (mutedUntil && Number.isNaN(mutedUntil.getTime())) {
        throw new ORPCError("VALIDATION_FAILED", { message: "Ungültige Stummschaltzeit" });
      }
      const [row] = await db
        .update(assets)
        .set({ mutedUntil })
        .where(eq(assets.id, input.id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Prüfung nicht gefunden" });
      return row;
    }),

  // Pull inventory from a connector that supports discovery (e.g. Route 53).
  discover: authed
    .input(v.object({ connectorId: v.string(), connectionId: v.string() }))
    .handler(async ({ input }): Promise<DiscoveredAsset[]> => {
      const connector = connectorOrThrow(input.connectorId);
      if (!connector.discover || !connector.capabilities.inventory) {
        throw new ORPCError("VALIDATION_FAILED", {
          message: `Connector "${input.connectorId}" does not support discovery`,
        });
      }
      const secrets = await loadConnectionSecret(input.connectionId);
      const config = parseConfig(connector, {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        return await connector.discover(config, secrets, {
          signal: controller.signal,
          now: new Date(),
        });
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "Discovery failed",
        });
      } finally {
        clearTimeout(timer);
      }
    }),

  // Turn an address into coordinates via OpenStreetMap Nominatim (free, no key).
  // Nominatim requires a descriptive User-Agent and asks callers to stay light.
  geocode: authed
    .input(v.object({ query: v.pipe(v.string(), v.trim(), v.minLength(1)) }))
    .handler(async ({ input }) => {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "5");
      url.searchParams.set("q", input.query);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Kataster/1.0 (customer address lookup)",
            "Accept-Language": "en",
          },
        });
        if (!res.ok) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Geocoding failed (${res.status})`,
          });
        }
        const rows = (await res.json()) as Array<{
          display_name?: string;
          lat?: string;
          lon?: string;
        }>;
        return rows
          .map((r) => ({
            label: r.display_name ?? "",
            latitude: Number(r.lat),
            longitude: Number(r.lon),
          }))
          .filter((r) => r.label && Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
      } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof Error ? error.message : "Geocoding failed",
        });
      } finally {
        clearTimeout(timer);
      }
    }),
};
