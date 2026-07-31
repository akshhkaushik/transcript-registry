"use client";

import { useEffect, useRef, useState } from "react";
import type { JobEventType, TranscriptSegment } from "../../lib/types";
import type {
  LocalContributionJob,
  PrepareReady,
  WorkerOutputMessage,
} from "./browser-types";
import {
  deleteLocalJob,
  listLocalJobs,
  loadPersistedMedia,
  persistMedia,
  saveLocalJob,
} from "./local-job-store";

type ActiveRun = {
  job: LocalContributionJob;
  worker: Worker;
  eventQueue: Promise<void>;
  releaseLock: () => void;
};

export function BrowserContribution() {
  const [jobs, setJobs] = useState<LocalContributionJob[]>([]);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("auto");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const activeRun = useRef<ActiveRun | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let mounted = true;
    void listLocalJobs()
      .then(async (stored) => {
        const recovered = stored.map((job) =>
          job.state === "running" || job.state === "uploading"
            ? {
                ...job,
                state: "paused" as const,
                stage: "paused-after-browser-exit",
                updatedAt: new Date().toISOString(),
              }
            : job,
        );
        await Promise.all(recovered.map(saveLocalJob));
        if (mounted) setJobs(recovered);
      })
      .catch((error) => {
        if (mounted) setNotice(errorMessage(error));
      });
    if ("BroadcastChannel" in window) {
      channel.current = new BroadcastChannel("transcript-registry-jobs");
      channel.current.onmessage = () => {
        if (!activeRun.current) void refreshStoredJobs(setJobs);
      };
    }
    return () => {
      mounted = false;
      activeRun.current?.worker.terminate();
      activeRun.current?.releaseLock();
      channel.current?.close();
    };
  }, []);

  const replaceJob = (next: LocalContributionJob) => {
    if (activeRun.current?.job.jobId === next.jobId) {
      activeRun.current.job = next;
    }
    setJobs((current) => [
      next,
      ...current.filter((job) => job.jobId !== next.jobId),
    ]);
    persistenceQueue.current = persistenceQueue.current
      .catch(() => undefined)
      .then(() => saveLocalJob(next))
      .catch((error) => setNotice(`Local checkpoint failed: ${errorMessage(error)}`));
    channel.current?.postMessage({
      jobId: next.jobId,
      state: next.state,
      progressPercent: next.progressPercent,
      stage: next.stage,
    });
  };

  const create = async () => {
    if (!file || !url.trim() || !rightsConfirmed) {
      setNotice(
        "Choose the matching media file, enter its YouTube URL, and confirm publication rights.",
      );
      return;
    }
    setBusy(true);
    setNotice("Reserving the Registry job…");
    try {
      const response = await fetch("/api/contributions/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const prepared = (await response.json()) as
        | PrepareReady
        | {
            status?: string;
            error?: string;
            transcript?: string;
          };
      if (prepared.status === "complete") {
        setNotice("This transcript is already in the Registry.");
        return;
      }
      if (
        !response.ok ||
        prepared.status !== "ready" ||
        !("jobId" in prepared)
      ) {
        throw new Error(
          ("error" in prepared && prepared.error) ||
            "The contribution could not be prepared.",
        );
      }
      const readyPreparation = prepared as PrepareReady;
      const now = new Date().toISOString();
      const job: LocalContributionJob = {
        ...readyPreparation,
        state: "prepared",
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        language,
        backend: null,
        processedSeconds: 0,
        totalSeconds: null,
        etaSeconds: null,
        progressPercent: 0,
        stage: "copying-to-private-storage",
        segments: [],
        sequence: readyPreparation.eventCursor,
        processingStartedAt: null,
        createdAt: now,
        updatedAt: now,
        error: null,
      };
      replaceJob(job);
      setNotice(
        "Copying media into this origin’s private storage so the job can resume after a browser restart…",
      );
      await persistMedia(job.jobId, file);
      const ready = {
        ...job,
        stage: "ready",
        updatedAt: new Date().toISOString(),
      };
      replaceJob(ready);
      setFile(null);
      await run(ready);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const publishEvent = (
    runState: ActiveRun,
    type: JobEventType,
    payload: Record<string, unknown>,
  ) => {
    const sequence = runState.job.sequence + 1;
    replaceJob({
      ...runState.job,
      sequence,
      updatedAt: new Date().toISOString(),
    });
    runState.eventQueue = runState.eventQueue
      .then(async () => {
        await refreshGrantIfNeeded(runState, replaceJob);
        const response = await fetch(runState.job.events, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${runState.job.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            sequence,
            type,
            payload,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || "Progress event was rejected.");
        }
      })
      .catch((error) => {
        setNotice(
          `Transcription is still local, but Registry progress could not sync: ${errorMessage(error)}`,
        );
      });
  };

  const run = async (job: LocalContributionJob) => {
    if (activeRun.current) {
      setNotice("Pause the active transcription before starting another.");
      return;
    }
    let acquiredLock: (() => void) | null = null;
    try {
      acquiredLock = await acquireJobLock(job.jobId);
      if (!acquiredLock) {
        throw new Error("This transcription is already running in another tab.");
      }
      const source = await loadPersistedMedia(job);
      const worker = new Worker(
        new URL("./transcription.worker.ts", import.meta.url),
        { type: "module" },
      );
      const running: LocalContributionJob = {
        ...job,
        state: "running",
        stage: job.processedSeconds ? "resuming" : "starting",
        processingStartedAt: job.processingStartedAt ?? new Date().getTime(),
        error: null,
        updatedAt: new Date().toISOString(),
      };
      const runState: ActiveRun = {
        job: running,
        worker,
        eventQueue: Promise.resolve(),
        releaseLock: acquiredLock,
      };
      activeRun.current = runState;
      acquiredLock = null;
      setActiveJobId(job.jobId);
      replaceJob(running);
      publishEvent(runState, job.processedSeconds ? "job.resumed" : "job.accepted", {
        stage: running.stage,
        processedSeconds: running.processedSeconds,
        progressPercent: running.progressPercent,
      });
      worker.onmessage = (event: MessageEvent<WorkerOutputMessage>) => {
        void handleWorkerMessage(runState, event.data);
      };
      worker.onerror = (event) => {
        void failRun(runState, event.message || "The transcription worker crashed.");
      };
      worker.postMessage({
        type: "start",
        file: source,
        startAt: job.processedSeconds,
        language: job.language,
      });
      setNotice(
        "Transcription is running locally. You can keep using the site; no media bytes are sent to the Registry.",
      );
    } catch (error) {
      acquiredLock?.();
      const failed = {
        ...job,
        state: "failed" as const,
        stage: "failed",
        error: errorMessage(error),
        updatedAt: new Date().toISOString(),
      };
      replaceJob(failed);
      setNotice(failed.error);
    }
  };

  const handleWorkerMessage = async (
    runState: ActiveRun,
    message: WorkerOutputMessage,
  ) => {
    if (activeRun.current !== runState) return;
    if (message.type === "stage") {
      const next = {
        ...runState.job,
        stage: message.stage,
        backend: message.backend ?? runState.job.backend,
        updatedAt: new Date().toISOString(),
      };
      replaceJob(next);
      if (
        message.stage === "model-loading" ||
        message.stage === "model-fallback"
      ) {
        publishEvent(runState, "model.loading", {
          stage: message.stage,
          backend: message.backend,
          message: message.message,
        });
      }
      return;
    }
    if (message.type === "segment") {
      const next = {
        ...runState.job,
        segments: appendSegment(runState.job.segments, message.segment),
        updatedAt: new Date().toISOString(),
      };
      replaceJob(next);
      return;
    }
    if (message.type === "progress") {
      replaceJob({
        ...runState.job,
        ...message,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (message.type === "checkpoint") {
      const next = {
        ...runState.job,
        processedSeconds: message.processedSeconds,
        totalSeconds: message.totalSeconds,
        progressPercent:
          (message.processedSeconds / message.totalSeconds) * 100,
        stage: "checkpointed",
        updatedAt: new Date().toISOString(),
      };
      replaceJob(next);
      publishEvent(runState, "job.checkpointed", {
        stage: "transcribing",
        progressPercent: next.progressPercent,
        processedSeconds: next.processedSeconds,
        totalSeconds: next.totalSeconds,
        etaSeconds: next.etaSeconds,
        backend: next.backend,
      });
      return;
    }
    if (message.type === "complete") {
      const next = {
        ...runState.job,
        processedSeconds: message.processedSeconds,
        totalSeconds: message.totalSeconds,
        progressPercent: 100,
        etaSeconds: 0,
        stage: "uploading-transcript",
        state: "uploading" as const,
        updatedAt: new Date().toISOString(),
      };
      replaceJob(next);
      await uploadTranscript(runState);
      return;
    }
    await failRun(runState, message.error);
  };

  const uploadTranscript = async (runState: ActiveRun) => {
    try {
      await runState.eventQueue;
      await refreshGrantIfNeeded(runState, replaceJob);
      const job = runState.job;
      const segments = job.segments.filter((segment) => segment.text.trim());
      const transcriptText = segments
        .map((segment) => segment.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!transcriptText) throw new Error("Whisper returned no transcript text.");
      const processingSeconds = job.processingStartedAt
        ? Math.round((new Date().getTime() - job.processingStartedAt) / 1000)
        : undefined;
      const response = await fetch(job.upload, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${job.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "youtube",
          providerId: job.videoId,
          sourceUrl: job.source,
          durationSeconds: job.totalSeconds,
          language: job.language === "auto" ? "und" : job.language,
          transcriptSource: "local-asr",
          license: "unknown",
          transcriptText,
          segments,
          processingSeconds,
          rightsConfirmed: true,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        transcript?: string;
      };
      if (!response.ok) throw new Error(body.error || "Transcript upload failed.");
      runState.worker.terminate();
      runState.releaseLock();
      activeRun.current = null;
      setActiveJobId(null);
      await persistenceQueue.current;
      await deleteLocalJob(job.jobId);
      setJobs((current) =>
        current.filter((candidate) => candidate.jobId !== job.jobId),
      );
      setNotice(
        `Transcription completed and the validated transcript was published: ${body.transcript ?? job.afterCompletion.transcript}`,
      );
    } catch (error) {
      await failRun(runState, errorMessage(error));
    }
  };

  const failRun = async (runState: ActiveRun, error: string) => {
    runState.worker.terminate();
    runState.releaseLock();
    const failed = {
      ...runState.job,
      state: "failed" as const,
      stage: "failed",
      error,
      updatedAt: new Date().toISOString(),
    };
    replaceJob(failed);
    publishEvent(runState, "job.failed", {
      stage: "failed",
      processedSeconds: failed.processedSeconds,
      progressPercent: failed.progressPercent,
      message: "Local transcription failed; details remain on the device.",
    });
    activeRun.current = null;
    setActiveJobId(null);
    setNotice(error);
  };

  const pause = (job: LocalContributionJob) => {
    const runState = activeRun.current;
    if (!runState || runState.job.jobId !== job.jobId) return;
    runState.worker.terminate();
    runState.releaseLock();
    const paused = {
      ...runState.job,
      state: "paused" as const,
      stage: "paused",
      updatedAt: new Date().toISOString(),
    };
    replaceJob(paused);
    publishEvent(runState, "job.paused", {
      stage: "paused",
      processedSeconds: paused.processedSeconds,
      totalSeconds: paused.totalSeconds,
      progressPercent: paused.progressPercent,
    });
    activeRun.current = null;
    setActiveJobId(null);
    setNotice("Transcription paused at the last durable 30-second checkpoint.");
  };

  const cancel = async (job: LocalContributionJob) => {
    const runState = activeRun.current;
    if (runState?.job.jobId === job.jobId) {
      runState.worker.terminate();
      runState.releaseLock();
      publishEvent(runState, "job.cancelled", {
        stage: "cancelled",
        processedSeconds: runState.job.processedSeconds,
        progressPercent: runState.job.progressPercent,
      });
      await runState.eventQueue;
      activeRun.current = null;
      setActiveJobId(null);
    }
    try {
      const holder = runState ?? { job };
      await refreshGrantIfNeeded(holder, replaceJob);
      const current = holder.job;
      await fetch(current.release, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${current.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Cancelled in browser" }),
      });
    } finally {
      await persistenceQueue.current;
      await deleteLocalJob(job.jobId);
      setJobs((current) =>
        current.filter((candidate) => candidate.jobId !== job.jobId),
      );
      setNotice("Local media, checkpoints, and transcript chunks were deleted.");
    }
  };

  return (
    <>
      <section>
        <h2>Start a local transcription</h2>
        <div className="local-contribution-form">
          <label>
            YouTube URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
              disabled={busy}
            />
          </label>
          <label>
            Matching audio or video file
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          <label>
            Spoken language
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={busy}
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={busy}
            />
            I have permission to transcribe this media and publish its
            transcript to the public Registry.
          </label>
          <button type="button" onClick={() => void create()} disabled={busy}>
            {busy ? "Preparing…" : "Transcribe locally"}
          </button>
        </div>
        {notice ? <p role="status">{notice}</p> : null}
      </section>

      <section>
        <h2>Local jobs</h2>
        {jobs.length ? (
          <div className="local-job-list">
            {jobs.map((job) => (
              <article className="local-job" key={job.jobId}>
                <h3>{job.fileName}</h3>
                <p className="muted">
                  {job.videoId} · {job.backend ?? "backend pending"} ·{" "}
                  {job.stage}
                </p>
                <progress max={100} value={job.progressPercent} />
                <p>
                  {formatDuration(job.processedSeconds)} /{" "}
                  {formatDuration(job.totalSeconds)}
                  {job.etaSeconds == null
                    ? ""
                    : ` · about ${formatDuration(job.etaSeconds)} remaining`}
                </p>
                <p>{job.segments.length} timestamped chunks stored locally.</p>
                {job.error ? <p role="alert">{job.error}</p> : null}
                <div className="job-actions">
                  {job.state === "running" ? (
                    <button type="button" onClick={() => pause(job)}>
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void run(job)}
                      disabled={activeJobId !== null}
                    >
                      {job.processedSeconds ? "Resume" : "Start"}
                    </button>
                  )}
                  <button type="button" onClick={() => void cancel(job)}>
                    Cancel and delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No resumable local jobs on this device.</p>
        )}
      </section>
    </>
  );
}

async function refreshGrantIfNeeded(
  runState: { job: LocalContributionJob },
  replaceJob: (job: LocalContributionJob) => void,
): Promise<void> {
  if (new Date(runState.job.expiresAt).getTime() - Date.now() > 30 * 60 * 1000) {
    return;
  }
  const response = await fetch(runState.job.refresh, {
    method: "POST",
    headers: { Authorization: `Bearer ${runState.job.token}` },
  });
  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
    expiresAt?: string;
    error?: string;
  };
  if (!response.ok || !body.token || !body.expiresAt) {
    throw new Error(body.error || "The contribution grant could not be renewed.");
  }
  const refreshed = {
    ...runState.job,
    token: body.token,
    expiresAt: body.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  runState.job = refreshed;
  replaceJob(refreshed);
}

async function acquireJobLock(jobId: string): Promise<(() => void) | null> {
  if (!navigator.locks) return () => undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Promise((resolve) => {
    void navigator.locks.request(
      `transcript-registry:${jobId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve(release);
        await held;
      },
    );
  });
}

function appendSegment(
  segments: TranscriptSegment[],
  segment: TranscriptSegment,
): TranscriptSegment[] {
  const normalized = {
    ...segment,
    text: segment.text.replace(/\s+/g, " ").trim(),
  };
  return normalized.text ? [...segments, normalized] : segments;
}

async function refreshStoredJobs(
  setJobs: (jobs: LocalContributionJob[]) => void,
) {
  setJobs(await listLocalJobs());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder
        .toString()
        .padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
