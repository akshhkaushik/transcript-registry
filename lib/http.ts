import type { TranscriptRecord } from "./types";
import { runtimeEnvironment } from "../db/runtime";

export const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "index, follow",
};

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, val] of Object.entries(PUBLIC_HEADERS)) {
    headers.set(key, val);
  }
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

export function textResponse(
  value: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  for (const [key, val] of Object.entries(PUBLIC_HEADERS)) {
    headers.set(key, val);
  }
  return new Response(value, { ...init, headers });
}

export async function workerAuthorized(request: Request): Promise<boolean> {
  const expected =
    runtimeEnvironment().WORKER_TOKEN ?? process.env.WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const [left, right] = await Promise.all([digest(expected), digest(supplied)]);
  return left === right;
}

export async function clientHash(request: Request): Promise<string> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const salt =
    runtimeEnvironment().RATE_LIMIT_SALT ??
    process.env.RATE_LIMIT_SALT ??
    "transcript-registry";
  return digest(`${salt}:${ip}`);
}

export function transcriptAsText(transcript: TranscriptRecord): string {
  const lines = [
    `Title: ${transcript.title}`,
    `Channel: ${transcript.channel || "Unknown"}`,
    `Source: ${transcript.sourceUrl}`,
    `Language: ${transcript.language}`,
    `Transcript source: ${transcript.transcriptSource}`,
    `License: ${transcript.license}`,
    `Published: ${transcript.publishedAt ?? "Unknown"}`,
    `Duration: ${
      transcript.durationSeconds == null
        ? "Unknown"
        : formatTimestamp(transcript.durationSeconds)
    }`,
    `Words: ${transcript.wordCount}`,
    `Checksum: ${transcript.checksum}`,
    "",
    "Transcript",
    "",
  ];
  for (const segment of transcript.segments) {
    lines.push(`[${formatTimestamp(segment.start)}] ${segment.text}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatTimestamp(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
