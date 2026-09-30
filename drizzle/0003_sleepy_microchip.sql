CREATE TABLE "location_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"from_location_id" text NOT NULL,
	"to_location_id" text NOT NULL,
	"type" "relation_type" DEFAULT 'connects' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_relations_pair_unq" UNIQUE("from_location_id","to_location_id","type")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "location_relations" ADD CONSTRAINT "location_relations_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_relations" ADD CONSTRAINT "location_relations_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_relations_from_idx" ON "location_relations" USING btree ("from_location_id");--> statement-breakpoint
CREATE INDEX "location_relations_to_idx" ON "location_relations" USING btree ("to_location_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_location_idx" ON "assets" USING btree ("location_id");