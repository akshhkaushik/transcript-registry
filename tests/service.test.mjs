import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

class Statement {
  constructor(sql) {
    this.sql = sql;
  }
  bind() {
    return this;
  }
  async run() {
    return { meta: { changes: 1 } };
  }
  async first() {
    if (/count\(\*\)/i.test(this.sql)) return { count: 0 };
    return null;
  }
  async all() {
    return { results: [] };
  }
}

const environment = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
  DB: {
    prepare: (sql) => new Statement(sql),
    batch: async (statements) =>
      Promise.all(statements.map((statement) => statement.run())),
  },
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};

async function fetch(path, init = {}) {
  return worker.fetch(
    new Request(`http://registry.test${path}`, init),
    environment,
    context,
  );
}

test("renders only the minimal submission interface", async () => {
  const response = await fetch("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Transcript Registry/);
  assert.match(html, /action="\/api\/add"/);
  assert.match(html, /Add transcript/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Browse categories/i);
});

test("strict nonsense search returns zero results", async () => {
  const response = await fetch("/search.txt?q=yo%20what%27s%20up");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Results: 0/);
});

test("rejects a non-YouTube submission", async () => {
  const response = await fetch("/api/add", {
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
    fetch("/robots.txt").then((response) => response.text()),
    fetch("/llms.txt").then((response) => response.text()),
  ]);
  assert.match(robots, /User-agent: OAI-SearchBot[\s\S]*Allow: \//);
  assert.match(robots, /User-agent: Claude-SearchBot[\s\S]*Allow: \//);
  assert.match(llms, /\/search\.txt\?q=QUERY/);
  assert.match(llms, /\/youtube\/VIDEO_ID\.txt/);
});

test("missing transcript has a real 404", async () => {
  const response = await fetch("/youtube/abcdefghijk.txt");
  assert.equal(response.status, 404);
});
