CREATE TYPE "public"."mail_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TABLE "mail_events" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"message_id" text NOT NULL,
	"rcpt_index" integer DEFAULT 0 NOT NULL,
	"direction" "mail_direction" NOT NULL,
	"server_location_id" text,
	"customer_location_id" text,
	"domain_name" text NOT NULL,
	"sender" text,
	"recipient" text,
	"action" text,
	"score" double precision,
	"size_bytes" double precision,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_events_msg_unq" UNIQUE("asset_id","message_id","rcpt_index","direction")
);
--> statement-breakpoint
ALTER TABLE "mail_events" ADD CONSTRAINT "mail_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_events" ADD CONSTRAINT "mail_events_server_location_id_locations_id_fk" FOREIGN KEY ("server_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_events" ADD CONSTRAINT "mail_events_customer_location_id_locations_id_fk" FOREIGN KEY ("customer_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_events_occurred_idx" ON "mail_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "mail_events_asset_occurred_idx" ON "mail_events" USING btree ("asset_id","occurred_at");