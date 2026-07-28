ALTER TABLE "transcripts"
ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
	setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
	setweight(to_tsvector('english'::regconfig, coalesce("channel", '')), 'A') ||
	setweight(to_tsvector('english'::regconfig, coalesce("topics_json", '')), 'A') ||
	setweight(to_tsvector('english'::regconfig, coalesce("description", '')), 'B') ||
	setweight(to_tsvector('english'::regconfig, coalesce("transcript_text", '')), 'D')
) STORED;

CREATE INDEX "transcripts_search_vector_idx"
ON "transcripts"
USING gin ("search_vector");
