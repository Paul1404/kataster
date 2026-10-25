ALTER TYPE "public"."resource_provider" ADD VALUE 'contabo';--> statement-breakpoint
ALTER TYPE "public"."resource_provider" ADD VALUE 'stalwart';--> statement-breakpoint
ALTER TYPE "public"."resource_provider" ADD VALUE 'backblaze';--> statement-breakpoint
ALTER TYPE "public"."resource_type" ADD VALUE 'backup';--> statement-breakpoint
CREATE TABLE "host_inventory" (
	"hostname" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
