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
  assert.match(html, /action="\/api\/channels"/);
  assert.match(html, /Search videos and YouTube channels/);
  assert.match(html, /name="q"/);
  assert.match(html, /action="\/api\/channel-search"/);
  assert.match(html, /Channels with every transcript available/);
  assert.match(html, /Processing or partially covered channels/);
  assert.match(html, /Add a complete YouTube channel/);
  assert.match(html, /Request transcript/);
  assert.doesNotMatch(
    html,
    /codex-preview|react-loading-skeleton|Browse categories/i,
  );
});

test("unified search returns transcript videos and matching channels", async () => {
  const response = await request(
    "/search.json?q=action%20physics&limit=2&discover=0",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.results));
  assert.ok(Array.isArray(body.channels));
  assert.ok(
    body.channels.some((channel) => channel.name === "Action Physics"),
  );
});

test("channel status distinguishes coverage from completed workflow", async () => {
  const response = await request(
    "/channels/dd8575c9-52e4-48b6-b639-98c202a84284.json",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.progressPercent, 100);
  assert.ok(body.transcriptCoveragePercent < 100);
  assert.equal(body.fullyCovered, false);
  assert.ok(
    body.failureReasons.some((failure) =>
      /No captions.*ASR.*not permitted/i.test(failure.reason),
    ),
  );
});

test("rejects an empty YouTube channel discovery query", async () => {
  const response = await request("/api/channel-search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ q: "the" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /specific YouTube channel/);
});

test("returns completed worker-discovered YouTube channel candidates", async () => {
  const response = await request(
    "/api/channel-search?q=Mayo%20Clinic",
    { headers: { accept: "application/json" } },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "complete");
  assert.ok(
    body.results.some(
      (channel) =>
        channel.name === "Mayo Clinic" &&
        /^https:\/\/www\.youtube\.com\/channel\//.test(channel.url),
    ),
  );
});

test("on-demand returns an existing transcript immediately", async () => {
  const response = await request(
    "/on-demand.json?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DTxqe_CAD43c",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "complete");
  assert.equal(body.videoId, "Txqe_CAD43c");
  assert.match(body.text, /\/youtube\/Txqe_CAD43c\.txt$/);
});

test("on-demand rejects invalid sources without creating a job", async () => {
  const response = await request(
    "/on-demand.json?url=https%3A%2F%2Fexample.com%2Fvideo",
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).status, "invalid");
});

test("rejects a video URL submitted as a channel", async () => {
  const response = await request("/api/channels", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=Txqe_CAD43c",
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /YouTube channel URL/);
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
  assert.match(llms, /\/on-demand\.json\?url=YOUTUBE_URL/);
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
