import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { assets } from "./assets";

// Reusable credential sets. `secret` holds the AES-256-GCM encrypted blob of the
// connector's secretSchema object. Plaintext never leaves the server.
export const connections = pgTable(
  "connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    connectorId: text("connector_id").notNull(),
    secret: text("secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("connections_connector_idx").on(t.connectorId)],
);

export const connectionsRelations = relations(connections, ({ many }) => ({
  assets: many(assets),
}));
