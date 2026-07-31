import type { JobEvent } from "./types";

const EVENT_TYPES = new Set<JobEvent["type"]>([
  "job.accepted",
  "model.loading",
  "job.progress",
  "job.checkpointed",
  "job.paused",
  "job.resumed",
  "job.cancelled",
  "job.failed",
]);

export function parseContributionJobEvent(
  value: Record<string, unknown>,
): Omit<JobEvent, "jobId" | "createdAt"> {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const sequence =
    typeof value.sequence === "number" ? Math.floor(value.sequence) : 0;
  const type = value.type as JobEvent["type"];
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) {
    throw new Error("Event id is invalid");
  }
  if (sequence < 1 || sequence > 1_000_000) {
    throw new Error("Event sequence is invalid");
  }
  if (!EVENT_TYPES.has(type)) throw new Error("Event type is invalid");

  const rawPayload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as Record<string, unknown>)
      : {};
  const progressPercent = optionalNumber(
    rawPayload.progressPercent,
    "progressPercent",
    0,
    100,
  );
  const processedSeconds = optionalNumber(
    rawPayload.processedSeconds,
    "processedSeconds",
    0,
    48 * 60 * 60,
  );
  const totalSeconds = optionalNumber(
    rawPayload.totalSeconds,
    "totalSeconds",
    0,
    48 * 60 * 60,
  );
  const etaSeconds =
    rawPayload.etaSeconds === null
      ? null
      : optionalNumber(
          rawPayload.etaSeconds,
          "etaSeconds",
          0,
          48 * 60 * 60,
        );
  const stage = optionalShortText(rawPayload.stage, "stage", 100);
  const message = optionalShortText(rawPayload.message, "message", 300);
  const backend =
    rawPayload.backend === "webgpu" || rawPayload.backend === "wasm"
      ? rawPayload.backend
      : undefined;

  return {
    id,
    sequence,
    type,
    payload: {
      ...(stage === undefined ? {} : { stage }),
      ...(progressPercent === undefined ? {} : { progressPercent }),
      ...(processedSeconds === undefined ? {} : { processedSeconds }),
      ...(totalSeconds === undefined ? {} : { totalSeconds }),
      ...(etaSeconds === undefined ? {} : { etaSeconds }),
      ...(backend === undefined ? {} : { backend }),
      ...(message === undefined ? {} : { message }),
    },
  };
}

function optionalNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalShortText(
  value: unknown,
  name: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned || cleaned.length > maximumLength) {
    throw new Error(`${name} is invalid`);
  }
  return cleaned;
}
