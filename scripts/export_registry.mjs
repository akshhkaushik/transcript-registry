import { appendFile, writeFile } from "node:fs/promises";

const source = (
  process.argv[2] ??
  "https://transcript-registry.rurradvisors.chatgpt.site"
).replace(/\/$/, "");
const destination =
  process.argv[3] ?? "/private/tmp/transcript-registry-export.jsonl";
const concurrency = Math.max(1, Number(process.env.EXPORT_CONCURRENCY) || 20);

const sitemapResponse = await fetch(`${source}/sitemap.xml`);
if (!sitemapResponse.ok) {
  throw new Error(`Sitemap request failed: ${sitemapResponse.status}`);
}
const sitemap = await sitemapResponse.text();
const ids = [
  ...new Set(
    [...sitemap.matchAll(/\/youtube\/([A-Za-z0-9_-]{11})<\/loc>/g)].map(
      (match) => match[1],
    ),
  ),
];
if (!ids.length) throw new Error("The sitemap did not contain transcript IDs");

await writeFile(destination, "", "utf8");
let exported = 0;

for (let offset = 0; offset < ids.length; offset += concurrency) {
  const page = ids.slice(offset, offset + concurrency);
  const records = await Promise.all(
    page.map(async (id) => {
      const response = await fetch(`${source}/youtube/${id}.json`);
      if (!response.ok) {
        throw new Error(`Transcript ${id} failed: ${response.status}`);
      }
      const record = await response.json();
      if (record.providerId !== id || !record.transcriptText) {
        throw new Error(`Transcript ${id} returned invalid data`);
      }
      return record;
    }),
  );
  await appendFile(
    destination,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  exported += records.length;
  process.stdout.write(`\rExported ${exported}/${ids.length}`);
}

process.stdout.write("\n");
console.log(JSON.stringify({ source, destination, exported }));
