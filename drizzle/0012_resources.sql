CREATE TYPE "public"."resource_provider" AS ENUM('aws', 'hetzner', 'railway', 'mailcow', 'other');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('registered_domain', 'dns_zone', 'ses_identity', 'ses_tenant', 'cloudfront_distribution', 'acm_cert', 'mailbox', 'mail_domain', 'container', 'vps', 'railway_project', 'railway_service');--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "resource_type" NOT NULL,
	"provider" "resource_provider" NOT NULL,
	"external_id" text NOT NULL,
	"owner_customer_id" text,
	"parent_resource_id" text,
	"connection_id" text,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"monitor" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_provider_type_external_unq" UNIQUE("provider","type","external_id")
);
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_owner_customer_id_customers_id_fk" FOREIGN KEY ("owner_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_resource_id_resources_id_fk" FOREIGN KEY ("parent_resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resources_owner_idx" ON "resources" USING btree ("owner_customer_id");--> statement-breakpoint
CREATE INDEX "resources_type_idx" ON "resources" USING btree ("type");--> statement-breakpoint
CREATE INDEX "resources_parent_idx" ON "resources" USING btree ("parent_resource_id");