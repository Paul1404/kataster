CREATE TABLE "mail_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"name" text NOT NULL,
	"location_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"mailbox_count" integer DEFAULT 0 NOT NULL,
	"alias_count" integer DEFAULT 0 NOT NULL,
	"storage_bytes" double precision DEFAULT 0 NOT NULL,
	"messages" double precision DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domains_asset_name_unq" UNIQUE("asset_id","name")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"domain_name" text NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"location_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"quota_bytes" double precision DEFAULT 0 NOT NULL,
	"quota_used_bytes" double precision DEFAULT 0 NOT NULL,
	"messages" double precision DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_asset_address_unq" UNIQUE("asset_id","address")
);
--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_domains_location_idx" ON "mail_domains" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "mailboxes_location_idx" ON "mailboxes" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "mailboxes_asset_domain_idx" ON "mailboxes" USING btree ("asset_id","domain_name");