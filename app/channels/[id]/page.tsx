import { notFound } from "next/navigation";
import Link from "next/link";
import { getChannelProgress } from "../../../db/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "YouTube channel ingestion",
  robots: { index: false, follow: false },
};

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const channel = await getChannelProgress(id);
  if (!channel) notFound();
  const active = ["queued", "discovering", "processing"].includes(
    channel.status,
  );
  return (
    <main>
      <p>
        <Link href="/">← All channels</Link>
      </p>
      <h1>{channel.channelName || "YouTube channel"}</h1>
      <p>
        <a href={channel.channelUrl ?? channel.normalizedUrl}>
          {channel.channelUrl ?? channel.normalizedUrl}
        </a>
      </p>
      <progress
        value={channel.completedVideos + channel.failedVideos}
        max={Math.max(
          1,
          channel.reportedVideoCount ?? channel.discoveredVideos,
        )}
      />
      <dl>
        <dt>Status</dt>
        <dd>{channel.status}</dd>
        <dt>Videos reported by YouTube</dt>
        <dd>{channel.reportedVideoCount ?? "still discovering"}</dd>
        <dt>Videos discovered</dt>
        <dd>{channel.discoveredVideos}</dd>
        <dt>Completed</dt>
        <dd>{channel.completedVideos}</dd>
        <dt>Processing now</dt>
        <dd>{channel.processingVideos}</dd>
        <dt>Queued</dt>
        <dd>{channel.queuedVideos}</dd>
        <dt>Failed after retries</dt>
        <dd>{channel.failedVideos}</dd>
        <dt>Discovery batches</dt>
        <dd>{channel.batchesReceived}</dd>
        <dt>Video concurrency</dt>
        <dd>{channel.concurrency}</dd>
        <dt>Observed average</dt>
        <dd>
          {channel.averageProcessingSeconds == null
            ? "Calculating after the first completed videos"
            : `${formatDuration(channel.averageProcessingSeconds)} per video`}
        </dd>
        <dt>Observed throughput</dt>
        <dd>
          {channel.observedVideosPerMinute == null
            ? "Calculating"
            : `${channel.observedVideosPerMinute.toFixed(1)} terminal videos per minute`}
        </dd>
        <dt>Elapsed</dt>
        <dd>{formatDuration(channel.elapsedSeconds)}</dd>
        <dt>Estimated remaining</dt>
        <dd>
          {channel.estimatedSecondsRemaining == null
            ? "Calculating"
            : formatDuration(channel.estimatedSecondsRemaining)}
        </dd>
      </dl>
      {channel.error ? <p>{channel.error}</p> : null}
      <p className="muted">
        ETA is based on observed processing time and configured concurrency.
        Videos without captions may take much longer if local ASR is permitted.
      </p>
      <p className="muted">
        Machine status: <a href={`/channels/${id}.json`}>JSON</a>
      </p>
      {active ? <meta httpEquiv="refresh" content="10" /> : null}
    </main>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours} hours`;
}
