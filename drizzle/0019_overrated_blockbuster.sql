CREATE TABLE "resource_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_sources_resource_source_unq" UNIQUE("resource_id","source")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "ssm_patches" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "resource_sources" ADD CONSTRAINT "resource_sources_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_sources_resource_idx" ON "resource_sources" USING btree ("resource_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "provider_costs_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssm_patches" ADD CONSTRAINT "ssm_patches_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_resource_idx" ON "assets" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "ssm_patches_resource_idx" ON "ssm_patches" USING btree ("resource_id");