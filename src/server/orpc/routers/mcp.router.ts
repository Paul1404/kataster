import { desc } from "drizzle-orm";
import * as v from "valibot";
import { db } from "../../db";
import { mcpAuditLog } from "../../db/schema/mcp-tokens";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "../../mcp/tokens";
import { authed } from "../base";

export const mcpRouter = {
  // Tokens for the /api/mcp endpoint. Create returns the plaintext once.
  tokens: {
    list: authed.handler(() => listMcpTokens()),
    create: authed
      .input(
        v.object({
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
          access: v.optional(v.picklist(["read", "write"]), "read"),
        }),
      )
      .handler(({ input, context }) =>
        createMcpToken(
          input.name,
          input.access === "write" ? ["read", "write"] : ["read"],
          context.user.email ?? context.user.id,
        ),
      ),
    revoke: authed
      .input(v.object({ id: v.string() }))
      .handler(({ input }) => revokeMcpToken(input.id)),
  },
  audit: {
    list: authed.handler(() =>
      db.select().from(mcpAuditLog).orderBy(desc(mcpAuditLog.createdAt)).limit(100),
    ),
  },
};
