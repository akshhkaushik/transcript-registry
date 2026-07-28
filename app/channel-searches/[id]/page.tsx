import Link from "next/link";
import { notFound } from "next/navigation";
import { getChannelSearchJob } from "../../../db/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "YouTube channel search",
  robots: { index: false, follow: false },
};

export default async function ChannelSearchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getChannelSearchJob(id);
  if (!job) notFound();
  const active = job.status === "queued" || job.status === "processing";
  return (
    <main>
      <p>
        <Link href="/">← Registry</Link>
      </p>
      <h1>YouTube channels for “{job.query}”</h1>
      <p>Status: {job.status}</p>
      {active ? (
        <p>
          The owner-operated worker is searching YouTube. This page refreshes
          automatically.
        </p>
      ) : null}
      {job.results.length ? (
        <ol>
          {job.results.map((channel) => (
            <li key={channel.channelId}>
              <h2>
                <a href={channel.url}>{channel.name}</a>
              </h2>
              {channel.description ? <p>{channel.description}</p> : null}
              <form action="/api/channels" method="post">
                <input type="hidden" name="url" value={channel.url} />
                <button type="submit">Add every public video</button>
              </form>
            </li>
          ))}
        </ol>
      ) : job.status === "complete" ? (
        <p>No matching public YouTube channels were found.</p>
      ) : null}
      {job.error ? <p>Failure: {job.error}</p> : null}
      <p className="muted">
        Machine status:{" "}
        <a href={`/channel-searches/${id}.json`}>JSON</a>
      </p>
      {active ? <meta httpEquiv="refresh" content="5" /> : null}
    </main>
  );
}
