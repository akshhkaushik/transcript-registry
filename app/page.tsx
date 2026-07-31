import {
  getCounts,
  listChannelProgress,
  searchChannels,
  searchTranscripts,
} from "../db/store";
import type { ChannelProgress } from "../lib/types";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const query = (await searchParams).q?.trim().slice(0, 200) ?? "";
  const [counts, channels, videoResults, channelResults] = await Promise.all([
    getCounts(),
    listChannelProgress(100),
    query ? searchTranscripts(query, 10) : Promise.resolve([]),
    query ? searchChannels(query, 10) : Promise.resolve([]),
  ]);
  const activeChannels = channels.some((channel) =>
    ["queued", "discovering", "processing"].includes(channel.status),
  );
  const fullyCoveredChannels = channels.filter(
    (channel) => channel.fullyCovered,
  );
  const incompleteChannels = channels.filter(
    (channel) => !channel.fullyCovered,
  );
  return (
    <main>
      <h1>Transcript Registry</h1>

      <section>
        <h2>Search videos and YouTube channels</h2>
        <form action="/" method="get">
          <label htmlFor="library-search" hidden>
            Search transcript videos and channels
          </label>
          <input
            id="library-search"
            name="q"
            type="search"
            defaultValue={query}
            required
            placeholder="Search this library"
            aria-label="Search transcript videos and channels"
          />
          <button type="submit">Search</button>
        </form>
        {query ? (
          <SearchResults
            query={query}
            videos={videoResults}
            channels={channelResults}
          />
        ) : null}
      </section>

      <section>
        <h2>Find a new YouTube channel</h2>
        <p>
          This asks the local worker to search YouTube, then returns channel
          choices that can be added in full.
        </p>
        <form action="/api/channel-search" method="post">
          <label htmlFor="youtube-channel-search" hidden>
            Find a YouTube channel by name or topic
          </label>
          <input
            id="youtube-channel-search"
            name="q"
            type="search"
            required
            placeholder="Mayo Clinic, freeCodeCamp, physics…"
            aria-label="Find a YouTube channel by name or topic"
          />
          <button type="submit">Find channels</button>
        </form>
      </section>

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
        <h2>Request one transcript on demand</h2>
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
          <button type="submit">Request transcript</button>
        </form>
        <p className="muted">
          Agents can use <code>/on-demand.json?url=YOUTUBE_URL</code> and poll
          the returned job URL. You can{" "}
          <Link href="/contribute">transcribe a local media file in-browser</Link>
          , or coding agents can follow{" "}
          <Link href="/contribute.txt">the local contribution instructions</Link>{" "}
          to run captions or Whisper on the user&apos;s own computer and share
          the result with everyone.
        </p>
      </section>

      <p className="muted">
        {counts.transcripts.toLocaleString("en-US")} transcripts stored.{" "}
        {counts.queued + counts.processing
          ? `${counts.queued + counts.processing} videos processing.`
          : ""}
      </p>

      <section>
        <h2>Channels with every transcript available</h2>
        {fullyCoveredChannels.length ? (
          <ChannelTable channels={fullyCoveredChannels} />
        ) : (
          <p className="muted">
            No submitted channel is fully covered yet.
          </p>
        )}
      </section>
      <section>
        <h2>Processing or partially covered channels</h2>
        {incompleteChannels.length ? (
          <ChannelTable channels={incompleteChannels} />
        ) : (
          <p className="muted">No incomplete channels.</p>
        )}
      </section>
      {activeChannels ? <meta httpEquiv="refresh" content="15" /> : null}
    </main>
  );
}

function SearchResults({
  query,
  videos,
  channels,
}: {
  query: string;
  videos: Awaited<ReturnType<typeof searchTranscripts>>;
  channels: ChannelProgress[];
}) {
  return (
    <div className="search-results">
      <p>
        {videos.length} videos and {channels.length} channels for “{query}”.
      </p>
      {videos.length ? (
        <>
          <h3>Transcript videos</h3>
          <ol>
            {videos.map((video) => (
              <li key={video.providerId}>
                <Link href={`/youtube/${video.providerId}`}>
                  {video.title}
                </Link>{" "}
                <span className="muted">— {video.channel}</span>
                <p>{video.snippet}</p>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {channels.length ? (
        <>
          <h3>YouTube channels</h3>
          <ul>
            {channels.map((channel) => (
              <li key={channel.id}>
                <Link href={`/channels/${channel.id}`}>
                  {channel.channelName || channel.normalizedUrl}
                </Link>{" "}
                <span className="muted">
                  — {channel.completedVideos}/
                  {channel.reportedVideoCount ?? channel.discoveredVideos}{" "}
                  transcripts ({channel.transcriptCoveragePercent}%)
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!videos.length && !channels.length ? (
        <p className="muted">
          Nothing stored yet. Ask for an exact YouTube URL below or use the
          machine search endpoint to queue topic discovery.
        </p>
      ) : null}
      <p className="muted">
        Agent results:{" "}
        <a href={`/search.txt?q=${encodeURIComponent(query)}`}>text</a>
        {" · "}
        <a href={`/search.json?q=${encodeURIComponent(query)}`}>JSON</a>
      </p>
    </div>
  );
}

function ChannelTable({ channels }: { channels: ChannelProgress[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Transcript coverage</th>
            <th>Workflow</th>
            <th>Why incomplete</th>
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
      <td>
        {channel.completedVideos}/
        {channel.reportedVideoCount ?? channel.discoveredVideos} (
        {channel.transcriptCoveragePercent}%)
      </td>
      <td>
        {channel.status} · {channel.progressPercent}% jobs finished
      </td>
      <td>
        {channel.fullyCovered
          ? "Fully covered"
          : channel.failureReasons.length
            ? channel.failureReasons
                .map((reason) => `${reason.count}× ${reason.reason}`)
                .join("; ")
            : channel.queuedVideos + channel.processingVideos
              ? `${channel.queuedVideos} queued; ${channel.processingVideos} processing`
              : "Discovery has not completed"}
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
