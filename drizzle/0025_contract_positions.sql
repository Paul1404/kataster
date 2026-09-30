CREATE TYPE "public"."billing_interval" AS ENUM('monthly', 'yearly', 'once');--> statement-breakpoint
CREATE TABLE "contract_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"resource_id" text,
	"label" text NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"interval" "billing_interval" DEFAULT 'monthly' NOT NULL,
	"starts_period" text NOT NULL,
	"ends_period" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_address" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "vat_id" text;--> statement-breakpoint
ALTER TABLE "contract_positions" ADD CONSTRAINT "contract_positions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_positions" ADD CONSTRAINT "contract_positions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_positions_customer_idx" ON "contract_positions" USING btree ("customer_id");--> statement-breakpoint
-- Data: the latest flat monthly price per customer becomes an open-ended monthly
-- position starting in that period, so charges carry on exactly as before.
-- Older rows are superseded; all rows are removed because customer_pricing now
-- holds one-off adjustments only.
INSERT INTO "contract_positions" ("id", "customer_id", "label", "quantity", "unit_price_cents", "interval", "starts_period", "note")
SELECT gen_random_uuid()::text, p."customer_id", 'Pauschale', 1, p."amount_cents", 'monthly', p."period", 'Übernommen aus Monatspreis'
FROM "customer_pricing" p
JOIN (SELECT "customer_id", max("period") AS "period" FROM "customer_pricing" GROUP BY "customer_id") latest
  ON latest."customer_id" = p."customer_id" AND latest."period" = p."period"
WHERE p."amount_cents" > 0;--> statement-breakpoint
DELETE FROM "customer_pricing";
