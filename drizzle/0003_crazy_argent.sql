CREATE TABLE "channel_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"input_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"channel_id" text,
	"channel_name" text DEFAULT '' NOT NULL,
	"channel_url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"reported_video_count" integer,
	"batch_size" integer DEFAULT 50 NOT NULL,
	"concurrency" integer DEFAULT 4 NOT NULL,
	"batches_received" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"discovery_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_job_id" text NOT NULL,
	"provider" text DEFAULT 'youtube' NOT NULL,
	"provider_id" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"job_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "processing_seconds" integer;--> statement-breakpoint
ALTER TABLE "channel_videos" ADD CONSTRAINT "channel_videos_channel_job_id_channel_jobs_id_fk" FOREIGN KEY ("channel_job_id") REFERENCES "public"."channel_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_videos" ADD CONSTRAINT "channel_videos_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_jobs_normalized_url_idx" ON "channel_jobs" USING btree ("normalized_url");--> statement-breakpoint
CREATE INDEX "channel_jobs_status_created_idx" ON "channel_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_videos_channel_video_idx" ON "channel_videos" USING btree ("channel_job_id","provider_id");--> statement-breakpoint
CREATE INDEX "channel_videos_channel_status_idx" ON "channel_videos" USING btree ("channel_job_id","status");--> statement-breakpoint
CREATE INDEX "channel_videos_job_idx" ON "channel_videos" USING btree ("job_id");