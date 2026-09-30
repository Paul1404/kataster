import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { resources } from "./resources";

// One row per patch reported for an SSM-managed node: Installed (with the time it
// was applied) or Missing (pending). This is the "what updated and when" timeline
// plus the pending-update queue, keyed to the host CI via resourceId. The node's
// current patch-compliance rollup lives in the host's `ssm` resource_sources facet.
// Idempotent on (asset, instance, title, state).
export const ssmPatches = pgTable(
  "ssm_patches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    // The host CI these patches belong to.
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }),
    instanceId: text("instance_id").notNull(),
    title: text("title").notNull(), // e.g. NetworkManager.x86_64:1:1.54.3-3.el9_8
    kbId: text("kb_id"),
    classification: text("classification"), // Security | BugFix | Enhancement | ...
    severity: text("severity"), // Critical | Important | ... | null
    state: text("state").notNull(), // Installed | Missing
    installedAt: timestamp("installed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ssm_patches_asset_instance_title_state_unq").on(
      t.assetId,
      t.instanceId,
      t.title,
      t.state,
    ),
    index("ssm_patches_instance_idx").on(t.instanceId),
    index("ssm_patches_installed_idx").on(t.installedAt),
    index("ssm_patches_resource_idx").on(t.resourceId),
  ],
);

export const ssmPatchesRelations = relations(ssmPatches, ({ one }) => ({
  asset: one(assets, { fields: [ssmPatches.assetId], references: [assets.id] }),
}));
