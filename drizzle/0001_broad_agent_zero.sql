CREATE TABLE "topic_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"normalized_query" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_count" integer DEFAULT 8 NOT NULL,
	"found_count" integer DEFAULT 0 NOT NULL,
	"enqueued_count" integer DEFAULT 0 NOT NULL,
	"available_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "topic_jobs_normalized_query_idx" ON "topic_jobs" USING btree ("normalized_query");--> statement-breakpoint
CREATE INDEX "topic_jobs_status_created_idx" ON "topic_jobs" USING btree ("status","created_at");