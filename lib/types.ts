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
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};
