CREATE TABLE "channel_search_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"normalized_query" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_limit" integer DEFAULT 8 NOT NULL,
	"results_json" text DEFAULT '[]' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_search_jobs_query_idx" ON "channel_search_jobs" USING btree ("normalized_query");--> statement-breakpoint
CREATE INDEX "channel_search_jobs_status_created_idx" ON "channel_search_jobs" USING btree ("status","created_at");