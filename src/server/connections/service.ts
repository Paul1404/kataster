import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { requireConnector } from "../connectors/registry";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { db } from "../db";
import { assets } from "../db/schema/assets";
import { connections } from "../db/schema/connections";

export interface MaskedConnection {
  id: string;
  name: string;
  connectorId: string;
  connectorName: string;
  /** Names of the secret fields that currently hold a value. Values never leave the server. */
  setFields: string[];
  createdAt: Date;
  updatedAt: Date;
}

function requireSecretSchema(connectorId: string) {
  const connector = requireConnector(connectorId);
  if (!connector.secretSchema) {
    throw new ORPCError("VALIDATION_FAILED", {
      message: `Connector "${connectorId}" does not use credentials`,
    });
  }
  return { connector, secretSchema: connector.secretSchema };
}

function parseSecrets(connectorId: string, input: Record<string, unknown>) {
  const { secretSchema } = requireSecretSchema(connectorId);
  const result = v.safeParse(secretSchema, input);
  if (!result.success) {
    throw new ORPCError("VALIDATION_FAILED", {
      message: `Invalid credentials: ${result.issues.map((i) => i.message).join(", ")}`,
    });
  }
  return result.output as Record<string, unknown>;
}

function mask(row: typeof connections.$inferSelect): MaskedConnection {
  let setFields: string[] = [];
  try {
    setFields = Object.keys(decryptSecret(row.secret));
  } catch {
    setFields = [];
  }
  const connector = requireConnector(row.connectorId);
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorName: connector.name,
    setFields,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listConnections(): Promise<MaskedConnection[]> {
  const rows = await db.select().from(connections).orderBy(connections.name);
  return rows.map(mask);
}

export async function listConnectionsForConnector(
  connectorId: string,
): Promise<MaskedConnection[]> {
  const rows = await db.select().from(connections).where(eq(connections.connectorId, connectorId));
  return rows.map(mask);
}

export async function createConnection(input: {
  name: string;
  connectorId: string;
  secrets: Record<string, unknown>;
}): Promise<MaskedConnection> {
  const parsed = parseSecrets(input.connectorId, input.secrets);
  const [row] = await db
    .insert(connections)
    .values({
      name: input.name,
      connectorId: input.connectorId,
      secret: encryptSecret(parsed),
    })
    .returning();
  return mask(row!);
}

export async function updateConnection(input: {
  id: string;
  name?: string;
  secrets?: Record<string, unknown>;
}): Promise<MaskedConnection> {
  const [existing] = await db.select().from(connections).where(eq(connections.id, input.id));
  if (!existing) {
    throw new ORPCError("NOT_FOUND", { message: "Verbindung nicht gefunden" });
  }
  const patch: Partial<typeof connections.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.secrets !== undefined) {
    patch.secret = encryptSecret(parseSecrets(existing.connectorId, input.secrets));
  }
  const [row] = await db
    .update(connections)
    .set(patch)
    .where(eq(connections.id, input.id))
    .returning();
  return mask(row!);
}

export async function deleteConnection(id: string): Promise<void> {
  const inUse = await db.select({ id: assets.id }).from(assets).where(eq(assets.connectionId, id));
  if (inUse.length > 0) {
    throw new ORPCError("CONFLICT", {
      message: `Connection is used by ${inUse.length} asset(s). Reassign them first.`,
    });
  }
  await db.delete(connections).where(eq(connections.id, id));
}

/** Load and decrypt a connection's secret. Server-only (worker + discover). */
export async function loadConnectionSecret(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: "Verbindung nicht gefunden" });
  }
  return decryptSecret(row.secret);
}
