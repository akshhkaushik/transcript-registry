import { readFile } from "node:fs/promises";

const sourceFile =
  process.argv[2] ?? "/private/tmp/transcript-registry-export.jsonl";
const target = process.argv[3]?.replace(/\/$/, "");
if (!target) {
  throw new Error(
    "Usage: node scripts/import_registry.mjs EXPORT.jsonl https://deployment",
  );
}

const token = process.env.WORKER_TOKEN;
if (!token) throw new Error("WORKER_TOKEN is unavailable");

const records = (await readFile(sourceFile, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const total = records.length;
const batches = [];
let batch = [];
let bytes = 0;

for (const record of records) {
  const size = Buffer.byteLength(JSON.stringify(record));
  if (batch.length && (batch.length >= 20 || bytes + size > 2_500_000)) {
    batches.push(batch);
    batch = [];
    bytes = 0;
  }
  batch.push(record);
  bytes += size;
}
if (batch.length) batches.push(batch);

let imported = 0;
for (const [index, batchRecords] of batches.entries()) {
  const response = await fetch(`${target}/api/admin/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ records: batchRecords }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.imported !== batchRecords.length) {
    throw new Error(
      `Batch ${index + 1}/${batches.length} failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  imported += result.imported;
  process.stdout.write(`\rImported ${imported}/${total}`);
}

process.stdout.write("\n");
console.log(JSON.stringify({ target, imported, batches: batches.length }));
