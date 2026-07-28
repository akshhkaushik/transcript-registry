import { getCounts, listChannelProgress } from "../db/store";
import type { ChannelProgress } from "../lib/types";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [counts, channels] = await Promise.all([
    getCounts(),
    listChannelProgress(25),
  ]);
  const activeChannels = channels.some((channel) =>
    ["queued", "discovering", "processing"].includes(channel.status),
  );
  return (
    <main>
      <h1>Transcript Registry</h1>

      <section>
        <h2>Add a complete YouTube channel</h2>
        <p>
          Every public upload is discovered in batches. Caption retrieval runs
          concurrently on the local worker; permissioned Whisper fallback is
          limited separately to protect the machine.
        </p>
        <form action="/api/channels" method="post">
          <label htmlFor="channel-url" hidden>
            YouTube channel URL
          </label>
          <input
            id="channel-url"
            name="url"
            type="url"
            inputMode="url"
            required
            placeholder="https://www.youtube.com/@channel"
            aria-label="YouTube channel URL"
          />
          <button type="submit">Add channel</button>
        </form>
      </section>

      <section>
        <h2>Add one video</h2>
        <form action="/api/add" method="post">
          <label htmlFor="url" hidden>
            YouTube URL
          </label>
          <input
            id="url"
            name="url"
            type="url"
            inputMode="url"
            required
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube URL"
          />
          <button type="submit">Add transcript</button>
        </form>
      </section>

      <p className="muted">
        {counts.transcripts.toLocaleString("en-US")} transcripts stored.{" "}
        {counts.queued + counts.processing
          ? `${counts.queued + counts.processing} videos processing.`
          : ""}
      </p>

      <section>
        <h2>YouTube channels</h2>
        {channels.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Speed</th>
                  <th>ETA</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <ChannelRow channel={channel} key={channel.id} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No channels have been submitted yet.</p>
        )}
      </section>
      {activeChannels ? <meta httpEquiv="refresh" content="15" /> : null}
    </main>
  );
}

function ChannelRow({ channel }: { channel: ChannelProgress }) {
  const name =
    channel.channelName ||
    channel.normalizedUrl.split("/").filter(Boolean).at(-1) ||
    "YouTube channel";
  return (
    <tr>
      <td>
        <Link href={`/channels/${channel.id}`}>{name}</Link>
      </td>
      <td>{channel.status}</td>
      <td>
        {channel.completedVideos + channel.failedVideos}/
        {channel.reportedVideoCount ?? channel.discoveredVideos}
        {channel.failedVideos ? ` (${channel.failedVideos} failed)` : ""}
      </td>
      <td>
        {channel.averageProcessingSeconds
          ? `${formatDuration(channel.averageProcessingSeconds)}/video`
          : "measuring"}
        {channel.observedVideosPerMinute
          ? ` · ${channel.observedVideosPerMinute.toFixed(1)}/min`
          : ""}
      </td>
      <td>{formatEta(channel)}</td>
    </tr>
  );
}

function formatEta(channel: ChannelProgress): string {
  if (channel.status === "complete") return "done";
  if (channel.status === "failed") return "failed";
  if (channel.estimatedSecondsRemaining == null) return "calculating";
  return formatDuration(channel.estimatedSecondsRemaining);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
