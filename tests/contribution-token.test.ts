import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTRIBUTION_SECRET =
  "test-only-contribution-secret-with-more-than-32-characters";

const {
  createContributionGrant,
  verifyContributionGrant,
} = await import("../lib/contribution-token.ts");
const { validateContributedTranscript } = await import(
  "../lib/contribution.ts"
);
const { parseContributionJobEvent } = await import("../lib/job-events.ts");

test("contribution grants are job-scoped and reject tampering", async () => {
  const grant = await createContributionGrant({
    jobId: "job-1",
    videoId: "abcdefghijk",
  });
  const valid = await verifyContributionGrant(grant.token, {
    jobId: "job-1",
    videoId: "abcdefghijk",
  });
  assert.equal(valid?.jobId, "job-1");
  assert.equal(
    await verifyContributionGrant(grant.token, {
      jobId: "job-2",
      videoId: "abcdefghijk",
    }),
    null,
  );
  const tampered = `${grant.token.slice(0, -1)}${
    grant.token.endsWith("a") ? "b" : "a"
  }`;
  assert.equal(
    await verifyContributionGrant(tampered, {
      jobId: "job-1",
      videoId: "abcdefghijk",
    }),
    null,
  );
});

test("community transcript validation requires consistent segments", () => {
  const transcript = sampleTranscript();
  assert.equal(
    validateContributedTranscript(transcript, {}).transcriptText,
    "hello world",
  );
  assert.throws(
    () =>
      validateContributedTranscript(
        { ...transcript, transcriptText: "different" },
        {},
      ),
    /must match/,
  );
});

test("local ASR requires explicit rights confirmation", () => {
  const transcript = {
    ...sampleTranscript(),
    transcriptSource: "local-asr" as const,
  };
  assert.throws(
    () => validateContributedTranscript(transcript, {}),
    /confirmation/,
  );
  assert.doesNotThrow(() =>
    validateContributedTranscript(transcript, { rightsConfirmed: true }),
  );
});

test("browser progress events are bounded and omit transcript content", () => {
  const event = parseContributionJobEvent({
    id: "event_12345678",
    sequence: 4,
    type: "job.progress",
    payload: {
      stage: "transcribing",
      progressPercent: 42.5,
      processedSeconds: 120,
      totalSeconds: 300,
      etaSeconds: 180,
      backend: "webgpu",
      transcriptText: "must remain on the device",
    },
  });
  assert.equal(event.sequence, 4);
  assert.equal(event.payload.progressPercent, 42.5);
  assert.equal("transcriptText" in event.payload, false);
  assert.throws(
    () =>
      parseContributionJobEvent({
        id: "event_12345678",
        sequence: 5,
        type: "job.progress",
        payload: { progressPercent: 101 },
      }),
    /progressPercent/,
  );
});

function sampleTranscript() {
  return {
    id: "youtube:abcdefghijk",
    provider: "youtube" as const,
    providerId: "abcdefghijk",
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    title: "Example",
    channel: "Example",
    channelUrl: null,
    description: "",
    publishedAt: null,
    durationSeconds: 10,
    language: "en",
    transcriptSource: "creator-captions" as const,
    ingestionSource: "owner-worker" as const,
    license: "unknown",
    attribution: "",
    topics: [],
    transcriptText: "hello world",
    segments: [{ start: 0, end: 2, text: "hello world" }],
    wordCount: 2,
    checksum: "checksum",
  };
}
