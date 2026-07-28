let ready: Promise<void> | null = null;

export function rawDb(): D1Database {
  const database = runtimeEnvironment().DB;
  if (!database) {
    throw new Error("D1 binding DB is unavailable");
  }
  return database;
}

export function ensureDatabase(): Promise<void> {
  ready ??= initialize();
  return ready;
}

async function initialize(): Promise<void> {
  const db = rawDb();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT '',
        channel_url TEXT,
        description TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        duration_seconds INTEGER,
        language TEXT NOT NULL DEFAULT 'en',
        transcript_source TEXT NOT NULL,
        license TEXT NOT NULL DEFAULT 'unknown',
        attribution TEXT NOT NULL DEFAULT '',
        topics_json TEXT NOT NULL DEFAULT '[]',
        transcript_text TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TEXT,
        completed_at TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS submission_events (
        id TEXT PRIMARY KEY,
        client_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS transcripts_provider_video_idx ON transcripts(provider, provider_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS transcripts_updated_at_idx ON transcripts(updated_at)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS jobs_provider_video_idx ON jobs(provider, provider_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS submission_events_client_time_idx ON submission_events(client_hash, created_at)",
    ),
  ]);
}

export function runtimeEnvironment(): {
  DB?: D1Database;
  WORKER_TOKEN?: string;
  RATE_LIMIT_SALT?: string;
} {
  return (
    globalThis as typeof globalThis & {
      __TRANSCRIPT_ENV__?: {
        DB?: D1Database;
        WORKER_TOKEN?: string;
        RATE_LIMIT_SALT?: string;
      };
    }
  ).__TRANSCRIPT_ENV__ ?? {};
}
