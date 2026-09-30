import { createInsertSchema, createSelectSchema } from "drizzle-valibot";
import { assetGroups, assets, checkResults } from "./assets";
import { connections } from "./connections";

// drizzle-valibot generates base schemas from the table definitions. Note: jsonb
// columns (config, secret, payload_schema) are typed only as generic objects here.
// The real per-connector validation happens in procedures/worker via v.parse on
// the connector's configSchema / secretSchema.
export const assetInsertSchema = createInsertSchema(assets);
export const assetSelectSchema = createSelectSchema(assets);
export const assetGroupInsertSchema = createInsertSchema(assetGroups);
export const assetGroupSelectSchema = createSelectSchema(assetGroups);
export const checkResultSelectSchema = createSelectSchema(checkResults);
export const connectionInsertSchema = createInsertSchema(connections);
export const connectionSelectSchema = createSelectSchema(connections);
