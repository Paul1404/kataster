import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { type McpScope, mcpTokens } from "../db/schema/mcp-tokens";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `lfio_mcp_${randomBytes(24).toString("base64url")}`;
}

export interface McpTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: McpScope[];
  createdBy: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export async function listMcpTokens(): Promise<McpTokenSummary[]> {
  return db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      tokenPrefix: mcpTokens.tokenPrefix,
      scopes: mcpTokens.scopes,
      createdBy: mcpTokens.createdBy,
      lastUsedAt: mcpTokens.lastUsedAt,
      createdAt: mcpTokens.createdAt,
    })
    .from(mcpTokens)
    .orderBy(desc(mcpTokens.createdAt));
}

/** Create a token; the plaintext is returned once and never stored. */
export async function createMcpToken(
  name: string,
  scopes: McpScope[] = ["read"],
  createdBy: string | null = null,
): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const [row] = await db
    .insert(mcpTokens)
    .values({
      name,
      tokenHash: hashToken(token),
      tokenPrefix: `${token.slice(0, 13)}…`,
      scopes,
      createdBy,
    })
    .returning({ id: mcpTokens.id });
  return { id: row!.id, token };
}

export async function revokeMcpToken(id: string): Promise<void> {
  await db.delete(mcpTokens).where(eq(mcpTokens.id, id));
}

export interface McpTokenIdentity {
  id: string | null;
  name: string;
  scopes: McpScope[];
}

/** Return the stored token identity and stamp lastUsedAt. */
export async function verifyMcpToken(token: string): Promise<McpTokenIdentity | null> {
  const [row] = await db
    .select({ id: mcpTokens.id, name: mcpTokens.name, scopes: mcpTokens.scopes })
    .from(mcpTokens)
    .where(eq(mcpTokens.tokenHash, hashToken(token)));
  if (!row) return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.id));
  return row;
}
