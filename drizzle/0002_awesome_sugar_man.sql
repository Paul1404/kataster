CREATE TYPE "public"."relation_type" AS ENUM('depends_on', 'feeds', 'connects', 'monitors');--> statement-breakpoint
CREATE TABLE "asset_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"from_asset_id" text NOT NULL,
	"to_asset_id" text NOT NULL,
	"type" "relation_type" DEFAULT 'connects' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_relations_pair_unq" UNIQUE("from_asset_id","to_asset_id","type")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "asset_relations" ADD CONSTRAINT "asset_relations_from_asset_id_assets_id_fk" FOREIGN KEY ("from_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relations" ADD CONSTRAINT "asset_relations_to_asset_id_assets_id_fk" FOREIGN KEY ("to_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_relations_from_idx" ON "asset_relations" USING btree ("from_asset_id");--> statement-breakpoint
CREATE INDEX "asset_relations_to_idx" ON "asset_relations" USING btree ("to_asset_id");