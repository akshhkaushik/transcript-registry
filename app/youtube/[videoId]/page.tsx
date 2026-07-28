import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranscript } from "../../../db/store";
import { formatTimestamp } from "../../../lib/http";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ videoId: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { videoId } = await params;
  const transcript = await getTranscript("youtube", videoId);
  if (!transcript) return { title: "Transcript not found" };
  return {
    title: transcript.title,
    description: `Transcript of ${transcript.title} by ${transcript.channel}.`,
    alternates: {
      canonical: `/youtube/${videoId}`,
      types: {
        "text/plain": `/youtube/${videoId}.txt`,
        "application/json": `/youtube/${videoId}.json`,
      },
    },
    robots: { index: true, follow: true },
  };
}

export default async function TranscriptPage({ params }: PageProps) {
  const { videoId } = await params;
  const transcript = await getTranscript("youtube", videoId);
  if (!transcript) notFound();

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: transcript.title,
    description:
      transcript.description ||
      `Transcript of ${transcript.title} by ${transcript.channel}.`,
    uploadDate: transcript.publishedAt ?? undefined,
    duration:
      transcript.durationSeconds == null
        ? undefined
        : secondsToIsoDuration(transcript.durationSeconds),
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    url: transcript.sourceUrl,
    transcript: transcript.transcriptText,
  };

  return (
    <main>
      <article>
        <header>
          <h1>{transcript.title}</h1>
          <dl>
            <dt>Channel</dt>
            <dd>{transcript.channel || "Unknown"}</dd>
            <dt>Source</dt>
            <dd>
              <a href={transcript.sourceUrl}>YouTube</a>
            </dd>
            <dt>Transcript</dt>
            <dd>
              <a href={`/youtube/${videoId}.txt`}>plain text</a>
              {" · "}
              <a href={`/youtube/${videoId}.json`}>JSON</a>
            </dd>
            <dt>Language</dt>
            <dd>{transcript.language}</dd>
            <dt>Method</dt>
            <dd>{transcript.transcriptSource}</dd>
            <dt>License</dt>
            <dd>{transcript.license}</dd>
            <dt>Words</dt>
            <dd>{transcript.wordCount.toLocaleString("en-US")}</dd>
          </dl>
          {transcript.attribution ? (
            <p className="muted">{transcript.attribution}</p>
          ) : null}
        </header>

        <section aria-labelledby="transcript-heading">
          <h2 id="transcript-heading">Transcript</h2>
          {transcript.segments.map((segment, index) => {
            const second = Math.max(0, Math.floor(segment.start));
            return (
              <p
                className="segment"
                id={`t-${second}`}
                key={`${second}-${index}`}
              >
                <a
                  href={`https://www.youtube.com/watch?v=${videoId}&t=${second}s`}
                  aria-label={`Open source at ${formatTimestamp(second)}`}
                >
                  {formatTimestamp(second)}
                </a>
                <span>{segment.text}</span>
              </p>
            );
          })}
        </section>
      </article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeStructuredData(structuredData) }}
      />
    </main>
  );
}

function secondsToIsoDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remaining = whole % 60;
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${remaining}S`;
}

function safeStructuredData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
