import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { HostSnapshot } from "../../host-inventory/schema";

export const hostInventory = pgTable("host_inventory", {
  hostname: text("hostname").primaryKey(),
  payload: jsonb("payload").$type<HostSnapshot>().notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});
