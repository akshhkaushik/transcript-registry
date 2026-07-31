import type { TranscriptSegment } from "../../lib/types";

export type PrepareReady = {
  status: "ready";
  videoId: string;
  source: string;
  jobId: string;
  token: string;
  expiresAt: string;
  upload: string;
  release: string;
  events: string;
  refresh: string;
  publicEvents: string;
  eventCursor: number;
  afterCompletion: {
    transcript: string;
    text: string;
    json: string;
  };
};

export type LocalContributionJob = PrepareReady & {
  state:
    | "prepared"
    | "running"
    | "paused"
    | "uploading"
    | "failed";
  fileName: string;
  fileType: string;
  fileSize: number;
  language: string;
  backend: "webgpu" | "wasm" | null;
  processedSeconds: number;
  totalSeconds: number | null;
  etaSeconds: number | null;
  progressPercent: number;
  stage: string;
  segments: TranscriptSegment[];
  sequence: number;
  processingStartedAt: number | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

export type WorkerStartMessage = {
  type: "start";
  file: File;
  startAt: number;
  language: string;
};

export type WorkerOutputMessage =
  | {
      type: "stage";
      stage: string;
      backend?: "webgpu" | "wasm";
      message?: string;
    }
  | {
      type: "progress";
      processedSeconds: number;
      totalSeconds: number;
      etaSeconds: number | null;
      progressPercent: number;
    }
  | {
      type: "segment";
      segment: TranscriptSegment;
    }
  | {
      type: "checkpoint";
      processedSeconds: number;
      totalSeconds: number;
    }
  | {
      type: "complete";
      processedSeconds: number;
      totalSeconds: number;
    }
  | { type: "error"; error: string };
