CREATE TABLE "ssm_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"customer_id" text,
	"instance_id" text NOT NULL,
	"computer_name" text,
	"ip_address" text,
	"platform_name" text,
	"platform_version" text,
	"agent_version" text,
	"ping_status" text,
	"region" text,
	"last_ping_at" timestamp with time zone,
	"patch_installed" integer,
	"patch_missing" integer,
	"patch_failed" integer,
	"patch_missing_critical" integer,
	"patch_missing_security" integer,
	"last_scan_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssm_hosts_asset_instance_unq" UNIQUE("asset_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "ssm_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"title" text NOT NULL,
	"kb_id" text,
	"classification" text,
	"severity" text,
	"state" text NOT NULL,
	"installed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssm_patches_asset_instance_title_state_unq" UNIQUE("asset_id","instance_id","title","state")
);
--> statement-breakpoint
ALTER TABLE "ssm_hosts" ADD CONSTRAINT "ssm_hosts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssm_hosts" ADD CONSTRAINT "ssm_hosts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssm_patches" ADD CONSTRAINT "ssm_patches_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssm_hosts_customer_idx" ON "ssm_hosts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ssm_hosts_instance_idx" ON "ssm_hosts" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "ssm_patches_instance_idx" ON "ssm_patches" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "ssm_patches_installed_idx" ON "ssm_patches" USING btree ("installed_at");