CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`source_url` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`claimed_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_provider_video_idx` ON `jobs` (`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_created_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `submission_events` (
	`id` text PRIMARY KEY NOT NULL,
	`client_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submission_events_client_time_idx` ON `submission_events` (`client_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`channel` text DEFAULT '' NOT NULL,
	`channel_url` text,
	`description` text DEFAULT '' NOT NULL,
	`published_at` text,
	`duration_seconds` integer,
	`language` text DEFAULT 'en' NOT NULL,
	`transcript_source` text NOT NULL,
	`license` text DEFAULT 'unknown' NOT NULL,
	`attribution` text DEFAULT '' NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`transcript_text` text NOT NULL,
	`segments_json` text NOT NULL,
	`word_count` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_provider_video_idx` ON `transcripts` (`provider`,`provider_id`);--> statement-breakpoint
CREATE INDEX `transcripts_updated_at_idx` ON `transcripts` (`updated_at`);