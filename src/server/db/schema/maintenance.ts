import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { customers } from "./customers";

// A planned maintenance window. Scoped to a single asset or a whole location.
// While active, matching assets are suppressed: no incidents open and the UI
// shows a maintenance badge instead of red.
export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("maintenance_windows_asset_idx").on(t.assetId),
    index("maintenance_windows_customer_idx").on(t.customerId),
    index("maintenance_windows_time_idx").on(t.startsAt, t.endsAt),
  ],
);

export const maintenanceWindowsRelations = relations(maintenanceWindows, ({ one }) => ({
  asset: one(assets, { fields: [maintenanceWindows.assetId], references: [assets.id] }),
  location: one(customers, {
    fields: [maintenanceWindows.customerId],
    references: [customers.id],
  }),
}));
