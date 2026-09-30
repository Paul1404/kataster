CREATE TYPE "public"."resource_status" AS ENUM('active', 'decommissioned');--> statement-breakpoint
CREATE TABLE "resource_history" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "status" "resource_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_history" ADD CONSTRAINT "resource_history_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_history_resource_idx" ON "resource_history" USING btree ("resource_id","created_at");--> statement-breakpoint
CREATE INDEX "resources_status_idx" ON "resources" USING btree ("status");