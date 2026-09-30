DROP TABLE "asset_relations" CASCADE;--> statement-breakpoint
-- Data backfill: convert any asset that already had coordinates into a location
-- (reusing the asset id as the location id for a clean 1:1 link), then point the
-- asset at it. Must run before the coordinate columns are dropped below.
INSERT INTO "locations" ("id", "name", "address", "latitude", "longitude", "created_at", "updated_at")
  SELECT "id", "name", "address", "latitude", "longitude", now(), now()
  FROM "assets"
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;--> statement-breakpoint
UPDATE "assets" SET "location_id" = "id"
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "address";
