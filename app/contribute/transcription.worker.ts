/// <reference lib="webworker" />

import { pipeline } from "@huggingface/transformers";
import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
} from "mediabunny";
import type {
  WorkerOutputMessage,
  WorkerStartMessage,
} from "./browser-types";

const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 30;
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_SECONDS;
const MODEL_ID = "onnx-community/whisper-tiny";

self.onmessage = (event: MessageEvent<WorkerStartMessage>) => {
  if (event.data.type !== "start") return;
  void transcribe(event.data).catch((error) => {
    send({
      type: "error",
      error: error instanceof Error ? error.message : "Transcription failed",
    });
  });
};

async function transcribe(message: WorkerStartMessage): Promise<void> {
  send({ type: "stage", stage: "media-reading" });
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(message.file, { maxCacheSize: 16 * 1024 * 1024 }),
  });
  try {
    if (!(await input.canRead())) {
      throw new Error("The selected media container is not supported.");
    }
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("The selected file has no decodable audio track.");
    const firstTimestamp = await input.getFirstTimestamp([track]);
    const metadataDuration = await input.getDurationFromMetadata([track]);
    const endTimestamp =
      metadataDuration ?? (await input.computeDuration([track]));
    const totalSeconds = Math.max(0, endTimestamp - firstTimestamp);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      throw new Error("The media duration could not be determined.");
    }
    const startAt = Math.max(0, Math.min(message.startAt, totalSeconds));
    const transcriber = await loadTranscriber();
    const sink = new AudioSampleSink(track);
    let inputRate: number | null = null;
    let resampler: StreamingResampler | null = null;
    let chunk = new Float32Array(CHUNK_SAMPLES);
    let chunkLength = 0;
    let chunkStart = startAt;
    const wallStartedAt = performance.now();

    const commit = async (audio: Float32Array, duration: number) => {
      const result = await transcriber(audio, {
        return_timestamps: true,
        language: message.language === "auto" ? undefined : message.language,
        task: "transcribe",
      });
      const segments = result.chunks?.length
        ? result.chunks.map((part) => ({
            start: roundTimestamp(chunkStart + part.timestamp[0]),
            end: roundTimestamp(
              chunkStart + Math.min(duration, part.timestamp[1]),
            ),
            text: normalizeText(part.text),
          }))
        : [
            {
              start: roundTimestamp(chunkStart),
              end: roundTimestamp(chunkStart + duration),
              text: normalizeText(result.text),
            },
          ];
      for (const segment of segments) {
        if (segment.text) send({ type: "segment", segment });
      }
      chunkStart = Math.min(totalSeconds, chunkStart + duration);
      const elapsed = Math.max(0.001, (performance.now() - wallStartedAt) / 1000);
      const audioProcessed = Math.max(0.001, chunkStart - startAt);
      const remaining = Math.max(0, totalSeconds - chunkStart);
      send({
        type: "progress",
        processedSeconds: chunkStart,
        totalSeconds,
        progressPercent: (chunkStart / totalSeconds) * 100,
        etaSeconds: Math.round(remaining * (elapsed / audioProcessed)),
      });
      send({
        type: "checkpoint",
        processedSeconds: chunkStart,
        totalSeconds,
      });
    };

    send({ type: "stage", stage: "transcribing" });
    for await (const sample of sink.samples(firstTimestamp + startAt)) {
      try {
        const requestedTimestamp = firstTimestamp + startAt;
        const frameOffset = Math.max(
          0,
          Math.min(
            sample.numberOfFrames,
            Math.ceil(
              (requestedTimestamp - sample.timestamp) * sample.sampleRate,
            ),
          ),
        );
        const frameCount = sample.numberOfFrames - frameOffset;
        if (frameCount === 0) continue;
        if (inputRate === null) {
          inputRate = sample.sampleRate;
          resampler = new StreamingResampler(inputRate, TARGET_SAMPLE_RATE);
        } else if (sample.sampleRate !== inputRate) {
          throw new Error("Audio sample rate changed during decoding.");
        }
        const interleaved = new Float32Array(
          frameCount * sample.numberOfChannels,
        );
        sample.copyTo(interleaved, {
          format: "f32",
          planeIndex: 0,
          frameOffset,
          frameCount,
        });
        const mono = downmix(interleaved, sample.numberOfChannels);
        const output = resampler!.push(mono);
        let offset = 0;
        while (offset < output.length) {
          const count = Math.min(CHUNK_SAMPLES - chunkLength, output.length - offset);
          chunk.set(output.subarray(offset, offset + count), chunkLength);
          chunkLength += count;
          offset += count;
          if (chunkLength === CHUNK_SAMPLES) {
            await commit(chunk, CHUNK_SECONDS);
            chunk = new Float32Array(CHUNK_SAMPLES);
            chunkLength = 0;
          }
        }
      } finally {
        sample.close();
      }
    }

    if (chunkLength > TARGET_SAMPLE_RATE / 4) {
      const duration = chunkLength / TARGET_SAMPLE_RATE;
      await commit(chunk.slice(0, chunkLength), duration);
    }
    send({
      type: "complete",
      processedSeconds: totalSeconds,
      totalSeconds,
    });
  } finally {
    input.dispose();
  }
}

async function loadTranscriber() {
  const preferred: "webgpu" | "wasm" =
    "gpu" in navigator ? "webgpu" : "wasm";
  const load = async (backend: "webgpu" | "wasm") => {
    send({ type: "stage", stage: "model-loading", backend });
    return pipeline("automatic-speech-recognition", MODEL_ID, {
      device: backend,
      progress_callback: (progress: { status?: string; progress?: number }) => {
        if (progress.status === "progress") {
          send({
            type: "stage",
            stage: "model-downloading",
            backend,
            message:
              typeof progress.progress === "number"
                ? `${Math.round(progress.progress)}%`
                : undefined,
          });
        }
      },
    });
  };
  if (preferred === "wasm") return load("wasm");
  try {
    return await load("webgpu");
  } catch {
    send({
      type: "stage",
      stage: "model-fallback",
      backend: "wasm",
      message: "WebGPU initialization failed; using WASM.",
    });
    return load("wasm");
  }
}

class StreamingResampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);
  private position = 0;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    const combined = new Float32Array(this.carry.length + input.length);
    combined.set(this.carry);
    combined.set(input, this.carry.length);
    const output: number[] = [];
    while (this.position + 1 < combined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(
        combined[left] * (1 - fraction) + combined[left + 1] * fraction,
      );
      this.position += this.ratio;
    }
    const consumed = Math.floor(this.position);
    this.carry = combined.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

function downmix(
  interleaved: Float32Array,
  channels: number,
): Float32Array {
  if (channels === 1) return interleaved;
  const frames = interleaved.length / channels;
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      value += interleaved[frame * channels + channel];
    }
    mono[frame] = value / channels;
  }
  return mono;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roundTimestamp(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function send(message: WorkerOutputMessage): void {
  self.postMessage(message);
}

export {};
