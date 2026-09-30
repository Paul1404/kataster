-- Custom-app (push ingest) removal: their assets and history go with them.
DELETE FROM "assets" WHERE "connector_id" = 'custom';--> statement-breakpoint
ALTER TABLE "custom_apps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "custom_apps" CASCADE;--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_custom_app_key_unq";--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_custom_app_id_custom_apps_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "custom_app_id";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "asset_key";