CREATE TABLE "job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "progress_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "processed_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_seconds" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "eta_seconds" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "progress_stage" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "progress_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "latest_event_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_job_sequence_idx" ON "job_events" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "job_events_job_created_idx" ON "job_events" USING btree ("job_id","created_at");