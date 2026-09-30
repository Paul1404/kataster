-- Rename the CRM entity from "locations" to "customers". Pure rename + drop NOT NULL
-- on coordinates (the map becomes a view over customers that have coordinates).
-- Hand-authored: drizzle-kit's rename detection needs a TTY, so explicit RENAMEs are
-- used here instead of destructive DROP/CREATE.

ALTER TYPE "public"."location_kind" RENAME TO "customer_kind";--> statement-breakpoint
ALTER TYPE "public"."location_status" RENAME TO "customer_status";--> statement-breakpoint

ALTER TABLE "locations" RENAME TO "customers";--> statement-breakpoint
ALTER TABLE "location_contacts" RENAME TO "customer_contacts";--> statement-breakpoint
ALTER TABLE "location_relations" RENAME TO "customer_relations";--> statement-breakpoint

ALTER TABLE "assets" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "domains" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "web_distributions" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "certificates" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "mail_domains" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "mailboxes" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "maintenance_windows" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "customer_contacts" RENAME COLUMN "location_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "customer_relations" RENAME COLUMN "from_location_id" TO "from_customer_id";--> statement-breakpoint
ALTER TABLE "customer_relations" RENAME COLUMN "to_location_id" TO "to_customer_id";--> statement-breakpoint
ALTER TABLE "mail_events" RENAME COLUMN "server_location_id" TO "server_customer_id";--> statement-breakpoint
ALTER TABLE "mail_events" RENAME COLUMN "customer_location_id" TO "endpoint_customer_id";--> statement-breakpoint

ALTER INDEX "locations_kind_idx" RENAME TO "customers_kind_idx";--> statement-breakpoint
ALTER INDEX "location_contacts_location_idx" RENAME TO "customer_contacts_customer_idx";--> statement-breakpoint
ALTER INDEX "location_relations_from_idx" RENAME TO "customer_relations_from_idx";--> statement-breakpoint
ALTER INDEX "location_relations_to_idx" RENAME TO "customer_relations_to_idx";--> statement-breakpoint
ALTER INDEX "assets_location_idx" RENAME TO "assets_customer_idx";--> statement-breakpoint
ALTER INDEX "domains_location_idx" RENAME TO "domains_customer_idx";--> statement-breakpoint
ALTER INDEX "web_distributions_location_idx" RENAME TO "web_distributions_customer_idx";--> statement-breakpoint
ALTER INDEX "certificates_location_idx" RENAME TO "certificates_customer_idx";--> statement-breakpoint
ALTER INDEX "maintenance_windows_location_idx" RENAME TO "maintenance_windows_customer_idx";--> statement-breakpoint
ALTER INDEX "mail_domains_location_idx" RENAME TO "mail_domains_customer_idx";--> statement-breakpoint
ALTER INDEX "mailboxes_location_idx" RENAME TO "mailboxes_customer_idx";--> statement-breakpoint

ALTER TABLE "customer_relations" RENAME CONSTRAINT "location_relations_pair_unq" TO "customer_relations_pair_unq";--> statement-breakpoint

ALTER TABLE "assets" RENAME CONSTRAINT "assets_location_id_locations_id_fk" TO "assets_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "domains" RENAME CONSTRAINT "domains_location_id_locations_id_fk" TO "domains_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "web_distributions" RENAME CONSTRAINT "web_distributions_location_id_locations_id_fk" TO "web_distributions_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "certificates" RENAME CONSTRAINT "certificates_location_id_locations_id_fk" TO "certificates_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "mail_domains" RENAME CONSTRAINT "mail_domains_location_id_locations_id_fk" TO "mail_domains_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "mailboxes" RENAME CONSTRAINT "mailboxes_location_id_locations_id_fk" TO "mailboxes_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "maintenance_windows" RENAME CONSTRAINT "maintenance_windows_location_id_locations_id_fk" TO "maintenance_windows_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "customer_contacts" RENAME CONSTRAINT "location_contacts_location_id_locations_id_fk" TO "customer_contacts_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "customer_relations" RENAME CONSTRAINT "location_relations_from_location_id_locations_id_fk" TO "customer_relations_from_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "customer_relations" RENAME CONSTRAINT "location_relations_to_location_id_locations_id_fk" TO "customer_relations_to_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "mail_events" RENAME CONSTRAINT "mail_events_server_location_id_locations_id_fk" TO "mail_events_server_customer_id_customers_id_fk";--> statement-breakpoint
ALTER TABLE "mail_events" RENAME CONSTRAINT "mail_events_customer_location_id_locations_id_fk" TO "mail_events_endpoint_customer_id_customers_id_fk";--> statement-breakpoint

ALTER TABLE "customers" ALTER COLUMN "latitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "longitude" DROP NOT NULL;
