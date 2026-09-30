import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type McpScope = "read" | "write";

// Bearer tokens for the /api/mcp endpoint, generated and revoked in-app. Only the
// sha-256 hash is stored; the plaintext is shown once on creation. tokenPrefix is
// a short non-secret hint for display ("lfio_mcp_ab…").
export const mcpTokens = pgTable("mcp_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  scopes: jsonb("scopes").$type<McpScope[]>().notNull().default(["read"]),
  createdBy: text("created_by"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only record of authenticated MCP mutations. Attempt rows are written
// before a tool runs so an audit failure prevents the mutation itself.
export const mcpAuditLog = pgTable(
  "mcp_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tokenId: text("token_id").references(() => mcpTokens.id, { onDelete: "set null" }),
    tokenName: text("token_name").notNull(),
    toolName: text("tool_name").notNull(),
    phase: text("phase").notNull(),
    success: boolean("success"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mcp_audit_created_idx").on(t.createdAt),
    index("mcp_audit_token_idx").on(t.tokenId),
  ],
);
