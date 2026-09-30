CREATE TABLE "check_result_hourly" (
	"asset_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"total" integer NOT NULL,
	"down" integer NOT NULL,
	"degraded" integer NOT NULL,
	"latency_total_ms" integer NOT NULL,
	"latency_samples" integer NOT NULL,
	CONSTRAINT "check_result_hourly_asset_id_bucket_start_pk" PRIMARY KEY("asset_id","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "mcp_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text,
	"token_name" text NOT NULL,
	"tool_name" text NOT NULL,
	"phase" text NOT NULL,
	"success" boolean,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "scopes" jsonb DEFAULT '["read"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "check_result_hourly" ADD CONSTRAINT "check_result_hourly_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD CONSTRAINT "mcp_audit_log_token_id_mcp_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_result_hourly_time_idx" ON "check_result_hourly" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "mcp_audit_created_idx" ON "mcp_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_audit_token_idx" ON "mcp_audit_log" USING btree ("token_id");