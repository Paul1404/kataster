CREATE TYPE "public"."cert_source" AS ENUM('tls', 'acm');--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"location_id" text,
	"source" "cert_source" NOT NULL,
	"common_name" text NOT NULL,
	"sans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issuer" text,
	"not_after" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificates_asset_source_cn_unq" UNIQUE("asset_id","source","common_name")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"status" "check_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text,
	"location_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificates_location_idx" ON "certificates" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "certificates_not_after_idx" ON "certificates" USING btree ("not_after");--> statement-breakpoint
CREATE INDEX "incidents_asset_started_idx" ON "incidents" USING btree ("asset_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_asset" ON "incidents" USING btree ("asset_id") WHERE "incidents"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "maintenance_windows_asset_idx" ON "maintenance_windows" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_location_idx" ON "maintenance_windows" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_time_idx" ON "maintenance_windows" USING btree ("starts_at","ends_at");