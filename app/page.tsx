import { getCounts } from "../db/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const counts = await getCounts();
  return (
    <main>
      <h1>Transcript Registry</h1>
      <p>Paste a YouTube video that is missing.</p>
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
      <p className="muted">
        {counts.transcripts.toLocaleString("en-US")} transcripts stored.{" "}
        {counts.queued + counts.processing
          ? `${counts.queued + counts.processing} processing.`
          : ""}
      </p>
    </main>
  );
}
