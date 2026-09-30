CREATE TYPE "public"."allocation_mode" AS ENUM('fixed', 'weighted');--> statement-breakpoint
CREATE TYPE "public"."cost_source" AS ENUM('metered', 'fixed');--> statement-breakpoint
CREATE TABLE "cost_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"period" text NOT NULL,
	"mode" "allocation_mode" NOT NULL,
	"amount_cents" integer,
	"weight" double precision,
	"provider_cost_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_allocations_resource_period_unq" UNIQUE("resource_id","period")
);
--> statement-breakpoint
CREATE TABLE "customer_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"period" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_pricing_customer_period_unq" UNIQUE("customer_id","period")
);
--> statement-breakpoint
CREATE TABLE "provider_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "resource_provider" NOT NULL,
	"period" text NOT NULL,
	"label" text NOT NULL,
	"source" "cost_source" DEFAULT 'fixed' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_costs_provider_period_label_unq" UNIQUE("provider","period","label")
);
--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_provider_cost_id_provider_costs_id_fk" FOREIGN KEY ("provider_cost_id") REFERENCES "public"."provider_costs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_pricing" ADD CONSTRAINT "customer_pricing_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;