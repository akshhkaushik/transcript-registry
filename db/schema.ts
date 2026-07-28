import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const transcripts = sqliteTable(
  "transcripts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    title: text("title").notNull(),
    channel: text("channel").notNull().default(""),
    channelUrl: text("channel_url"),
    description: text("description").notNull().default(""),
    publishedAt: text("published_at"),
    durationSeconds: integer("duration_seconds"),
    language: text("language").notNull().default("en"),
    transcriptSource: text("transcript_source").notNull(),
    license: text("license").notNull().default("unknown"),
    attribution: text("attribution").notNull().default(""),
    topicsJson: text("topics_json").notNull().default("[]"),
    transcriptText: text("transcript_text").notNull(),
    segmentsJson: text("segments_json").notNull(),
    wordCount: integer("word_count").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("transcripts_provider_video_idx").on(
      table.provider,
      table.providerId,
    ),
    index("transcripts_updated_at_idx").on(table.updatedAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("jobs_provider_video_idx").on(table.provider, table.providerId),
    index("jobs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const submissionEvents = sqliteTable(
  "submission_events",
  {
    id: text("id").primaryKey(),
    clientHash: text("client_hash").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("submission_events_client_time_idx").on(table.clientHash, table.createdAt)],
);
