import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";

const port = 31_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";
const server = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "start", "--", "-p", String(port)],
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.on("data", (chunk) => {
  output += chunk;
});
server.stderr.on("data", (chunk) => {
  output += chunk;
});

after(() => {
  server.kill("SIGTERM");
});

await waitForServer();

test("renders only the minimal submission interface", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Transcript Registry/);
  assert.match(html, /action="\/api\/add"/);
  assert.match(html, /Add transcript/);
  assert.doesNotMatch(
    html,
    /codex-preview|react-loading-skeleton|Browse categories/i,
  );
});

test("strict nonsense search returns zero results", async () => {
  const response = await request(
    "/search.txt?q=yo%20what%27s%20up&discover=0",
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Results: 0/);
});

test("search uses whole words and honors its result limit", async () => {
  const response = await request(
    "/search.json?q=web%20development&limit=2&discover=0",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.ok(
    body.results.every((result) =>
      /\bweb\b/i.test(
        `${result.title} ${result.snippet}`,
      ),
    ),
  );
});

test("rejects a non-YouTube submission", async () => {
  const response = await request("/api/add", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ url: "https://example.com/not-a-video" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Enter a valid YouTube video URL.",
  });
});

test("publishes crawler rules and machine endpoint instructions", async () => {
  const [robots, llms] = await Promise.all([
    request("/robots.txt").then((response) => response.text()),
    request("/llms.txt").then((response) => response.text()),
  ]);
  assert.match(robots, /User-agent: OAI-SearchBot[\s\S]*Allow: \//);
  assert.match(robots, /User-agent: Claude-SearchBot[\s\S]*Allow: \//);
  assert.match(llms, /\/search\.txt\?q=QUERY/);
  assert.match(llms, /\/youtube\/VIDEO_ID\.txt/);
});

test("missing transcript has a real 404", async () => {
  const response = await request("/youtube/abcdefghijk.txt");
  assert.equal(response.status, 404);
});

test("publishes one known transcript as HTML, plain text, and JSON", async () => {
  const [html, text, json] = await Promise.all([
    request("/youtube/Txqe_CAD43c"),
    request("/youtube/Txqe_CAD43c.txt"),
    request("/youtube/Txqe_CAD43c.json"),
  ]);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Mayo Clinic Explains Diabetes/);
  assert.match(text.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await text.text(), /^Title: Mayo Clinic Explains Diabetes/m);
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal((await json.json()).providerId, "Txqe_CAD43c");
});

function request(path, init) {
  return fetch(`${baseUrl}${path}`, init);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before startup:\n${output}`);
    }
    try {
      const response = await request("/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not start:\n${output}`);
}
