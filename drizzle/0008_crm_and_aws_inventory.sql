CREATE TYPE "public"."location_kind" AS ENUM('provider', 'customer_private', 'customer_business', 'internal', 'partner');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('active', 'prospect', 'churned');--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"name" text NOT NULL,
	"location_id" text,
	"hosted_zone_id" text,
	"is_private_zone" boolean DEFAULT false NOT NULL,
	"record_count" integer,
	"dnssec_enabled" boolean,
	"registered" boolean DEFAULT false NOT NULL,
	"registrar" text,
	"registry_expires_at" timestamp with time zone,
	"auto_renew" boolean,
	"transfer_lock" boolean,
	"ses_verified" boolean DEFAULT false NOT NULL,
	"ses_sending_enabled" boolean,
	"ses_region" text,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_asset_name_unq" UNIQUE("asset_id","name")
);
--> statement-breakpoint
CREATE TABLE "web_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"distribution_id" text NOT NULL,
	"location_id" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_alias" text,
	"origin_domain" text,
	"behavior" text DEFAULT 'serve' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_distributions_asset_dist_unq" UNIQUE("asset_id","distribution_id")
);
--> statement-breakpoint
CREATE TABLE "location_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "kind" "location_kind" DEFAULT 'customer_business' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "status" "location_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_distributions" ADD CONSTRAINT "web_distributions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_distributions" ADD CONSTRAINT "web_distributions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_contacts" ADD CONSTRAINT "location_contacts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domains_location_idx" ON "domains" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "domains_name_idx" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "web_distributions_location_idx" ON "web_distributions" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "web_distributions_primary_alias_idx" ON "web_distributions" USING btree ("primary_alias");--> statement-breakpoint
CREATE INDEX "location_contacts_location_idx" ON "location_contacts" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "locations_kind_idx" ON "locations" USING btree ("kind");