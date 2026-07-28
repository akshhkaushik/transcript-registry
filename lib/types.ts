export type Provider = "youtube";

export type TranscriptSegment = {
  start: number;
  end: number | null;
  text: string;
};

export type TranscriptRecord = {
  id: string;
  provider: Provider;
  providerId: string;
  sourceUrl: string;
  title: string;
  channel: string;
  channelUrl: string | null;
  description: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  language: string;
  transcriptSource:
    | "creator-captions"
    | "automatic-captions"
    | "local-asr"
    | "licensed-dataset";
  ingestionSource:
    | "owner-worker"
    | "community-worker"
    | "dataset-import";
  license: string;
  attribution: string;
  topics: string[];
  transcriptText: string;
  segments: TranscriptSegment[];
  wordCount: number;
  checksum: string;
  createdAt?: string;
  updatedAt?: string;
};

export type IngestionJob = {
  id: string;
  provider: Provider;
  providerId: string;
  sourceUrl: string;
  status: "queued" | "processing" | "complete" | "failed";
  attempts: number;
  workerId: string | null;
  error: string | null;
  processingSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};

export type ChannelJob = {
  id: string;
  inputUrl: string;
  normalizedUrl: string;
  channelId: string | null;
  channelName: string;
  channelUrl: string | null;
  status: "queued" | "discovering" | "processing" | "complete" | "failed";
  reportedVideoCount: number | null;
  batchSize: number;
  concurrency: number;
  batchesReceived: number;
  attempts: number;
  workerId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  discoveryCompletedAt: string | null;
  completedAt: string | null;
};

export type ChannelProgress = ChannelJob & {
  discoveredVideos: number;
  completedVideos: number;
  queuedVideos: number;
  processingVideos: number;
  failedVideos: number;
  elapsedSeconds: number;
  averageProcessingSeconds: number | null;
  observedVideosPerMinute: number | null;
  estimatedSecondsRemaining: number | null;
  progressPercent: number;
};

export type TopicJob = {
  id: string;
  query: string;
  normalizedQuery: string;
  status: "queued" | "processing" | "complete" | "failed";
  targetCount: number;
  foundCount: number;
  enqueuedCount: number;
  availableCount: number;
  attempts: number;
  workerId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};
