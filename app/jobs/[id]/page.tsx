import { notFound } from "next/navigation";
import { getJob } from "../../../db/store";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Transcript job",
  robots: { index: false, follow: false },
};

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  return (
    <main>
      <h1>Transcript job</h1>
      <dl>
        <dt>Video</dt>
        <dd>
          <a href={job.sourceUrl}>{job.providerId}</a>
        </dd>
        <dt>Status</dt>
        <dd>{job.status}</dd>
        <dt>Attempts</dt>
        <dd>{job.attempts}</dd>
      </dl>
      {job.status === "complete" ? (
        <p>
          <a href={`/youtube/${job.providerId}`}>Read transcript</a>
        </p>
      ) : null}
      {job.status === "failed" && job.error ? <p>{job.error}</p> : null}
      {job.status === "queued" || job.status === "processing" ? (
        <>
          <p>The central worker will process this automatically.</p>
          <meta httpEquiv="refresh" content="15" />
        </>
      ) : null}
      <p className="muted">
        Machine status: <a href={`/jobs/${id}.json`}>JSON</a>
      </p>
    </main>
  );
}
