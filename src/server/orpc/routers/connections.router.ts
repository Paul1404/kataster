import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";
import {
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
} from "../../connections/service";
import { getConnector } from "../../connectors/registry";
import { db } from "../../db";
import { assets } from "../../db/schema/assets";
import { connections } from "../../db/schema/connections";
import { scheduleAsset } from "../../queue/schedule";
import { authed } from "../base";

export const connectionsRouter = {
  list: authed.handler(() => listConnections()),

  // One connection and what it powers: the connector it uses and the assets that
  // check through it (with live status), so the detail page can show its blast
  // radius rather than just credentials.
  get: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    const [row] = await db.select().from(connections).where(eq(connections.id, input.id)).limit(1);
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Verbindung nicht gefunden" });
    const connector = getConnector(row.connectorId);
    const poweredAssets = await db
      .select({
        id: assets.id,
        name: assets.name,
        target: assets.target,
        connectorId: assets.connectorId,
        enabled: assets.enabled,
        lastStatus: assets.lastStatus,
        lastCheckedAt: assets.lastCheckedAt,
      })
      .from(assets)
      .where(eq(assets.connectionId, input.id))
      .orderBy(asc(assets.name));
    return {
      id: row.id,
      name: row.name,
      connectorId: row.connectorId,
      connectorName: connector?.name ?? row.connectorId,
      connectorDescription: connector?.description ?? null,
      createdAt: row.createdAt,
      assets: poweredAssets,
    };
  }),

  create: authed
    .input(
      v.object({
        name: v.pipe(v.string(), v.minLength(1)),
        connectorId: v.pipe(v.string(), v.minLength(1)),
        secrets: v.record(v.string(), v.unknown()),
      }),
    )
    .handler(async ({ input }) => {
      const connection = await createConnection(input);

      // Single-target connectors (Hetzner, Railway) map one connection to one
      // asset -- create it now so adding the connection immediately starts
      // discovery, instead of leaving a connection with nothing to check.
      const connector = getConnector(input.connectorId);
      if (connector?.autoAssetTarget) {
        const existing = await db
          .select({ id: assets.id })
          .from(assets)
          .where(eq(assets.connectionId, connection.id));
        if (existing.length === 0) {
          const config = v.parse(connector.configSchema, {}) as Record<string, unknown>;
          const [asset] = await db
            .insert(assets)
            .values({
              name: connection.name,
              connectorId: input.connectorId,
              target: connector.autoAssetTarget(connection.name),
              config,
              connectionId: connection.id,
              intervalSeconds: connector.defaultIntervalSeconds ?? 60,
              enabled: true,
            })
            .returning();
          if (asset?.enabled) await scheduleAsset(asset.id, asset.intervalSeconds);
        }
      }

      return connection;
    }),

  update: authed
    .input(
      v.object({
        id: v.string(),
        name: v.optional(v.string()),
        secrets: v.optional(v.record(v.string(), v.unknown())),
      }),
    )
    .handler(({ input }) => updateConnection(input)),

  remove: authed.input(v.object({ id: v.string() })).handler(async ({ input }) => {
    await deleteConnection(input.id);
    return { ok: true };
  }),
};
