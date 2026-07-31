# Transcript Registry — Project Handoff

Last updated: 31 July 2026

This file is the durable context for a new Codex or developer session. Read it
before changing the project. It records the product goal, current architecture,
deployment ownership, completed features, operational commands, known
limitations, and the next major implementation direction. It intentionally
contains no secret values.

## Product goal

Transcript Registry is a free, public knowledge layer over YouTube videos.
ChatGPT Web, Claude, coding agents, search engines, and people should be able to:

1. search a topic with a normal public HTTP request;
2. receive relevant videos and short matching transcript excerpts;
3. open a stable HTML, plain-text, or JSON transcript page;
4. cite the original YouTube video and timestamped transcript;
5. request a missing video or channel;
6. reuse every completed transcript permanently without repeating transcription.

The important product is not a decorative website. The important product is a
reliable public corpus and small, agent-readable HTTP responses.

There are no reader accounts, subscriptions, or transcript paywalls.

## Repositories and ownership

- Application repository:
  <https://github.com/akshhkaushik/transcript-registry>
- Companion corpus/research repository:
  <https://github.com/akshhkaushik/transcript-commons>
- Required Git author:
  `akshhkaushik <171007528+akshhkaushik@users.noreply.github.com>`
- Production URL:
  <https://transcript-registry.vercel.app>
- Vercel login:
  `aksh08022006`
- Vercel owner/team:
  `aksh08022006s-projects` (`aksh08022006's projects`)
- Vercel project:
  `transcript-registry`
- Vercel project ID:
  `prj_EUT79sna8aA6HYvgbuFj0ezPobiM`
- Vercel organization ID:
  `team_OAXpBtL9cMNa7Zgry7wuTEBj`

Never deploy this project under `rurradvisors` or another Vercel account.
Always verify `npx --yes vercel@latest whoami` and `.vercel/project.json`
before deploying.

## Current system

### Public web application

The application is Next.js 16 using the App Router. Vercel serves the public
pages and APIs. Neon Postgres stores transcripts, jobs, channels, topic
discovery state, rate-limit state, and contribution reservations.

The useful public endpoints are:

- `GET /search.txt?q=TOPIC`
- `GET /search.json?q=TOPIC`
- `GET /on-demand.txt?url=YOUTUBE_URL`
- `GET /on-demand.json?url=YOUTUBE_URL`
- `GET /youtube/VIDEO_ID`
- `GET /youtube/VIDEO_ID.txt`
- `GET /youtube/VIDEO_ID.json`
- `GET /channels/CHANNEL_JOB_ID`
- `GET /channels/CHANNEL_JOB_ID.json`
- `GET /topics/TOPIC_JOB_ID.json`
- `GET /jobs/VIDEO_JOB_ID.json`
- `GET /contribute.txt`
- `GET /contribute.py`
- `GET /contribute.sh`
- `GET /llms.txt`
- `GET /robots.txt`
- `GET /sitemap.xml`
- `GET /api/health`

HTML exists for humans and indexing. Plain text and JSON are the primary agent
interfaces.

### Search

`db/store.ts` uses a Postgres generated `tsvector` and
`plainto_tsquery('english', ...)`. Search results are ranked with `ts_rank`.
Each result includes a compact matching snippet rather than embedding the full
transcript in the search response.

A search with zero transcript results creates or reuses a topic-discovery job
unless `discover=0` is supplied. The response includes a status URL for agents
to poll.

Search also returns matching tracked YouTube channels and their real transcript
coverage.

### One-video on-demand flow

1. `/api/on-demand` accepts a YouTube URL or 11-character video ID.
2. An existing transcript is returned immediately.
3. Otherwise the application deduplicates the request and creates a video job.
4. The response is HTTP `202` with a job URL and polling delay.
5. An owner worker or a requesting-user contributor claims the job.
6. Captions are preferred. Permitted audio can fall back to local ASR.
7. Only the transcript, timestamps, metadata, and source information are saved.
8. Temporary audio and caption files are deleted.
9. Future requests receive the stored result immediately.

### Decentralized contribution flow

`public/contribute.py` and `public/contribute.sh` let a coding agent use the
requesting user's computer instead of the site owner's Mac.

The contribution protocol:

1. creates a short-lived token bound to one video and one job;
2. reserves the job to prevent duplicate owner processing;
3. tries creator captions, then automatic captions;
4. optionally runs MLX Whisper or configured whisper.cpp when captions are
   absent and the user explicitly enables ASR;
5. uploads transcript data, never audio;
6. releases or completes the reservation;
7. deletes local temporary files;
8. prints status and URLs without dumping the transcript into agent context.

Relevant server routes are under `app/api/contributions/`.

### Browser-local asynchronous contribution

`/contribute` adds a no-install path for permissioned local ASR. Selected media
is copied to OPFS and never sent to Registry. A dedicated browser worker uses
Mediabunny/WebCodecs for bounded decoding and Transformers.js Whisper with a
WebGPU-to-WASM fallback. IndexedDB stores timestamped chunks and 30-second
checkpoints so a paused or discarded tab can resume.

The durable control plane adds ordered, idempotent `job_events`, summarized
progress/ETA fields on `jobs`, 12-hour renewable contribution grants, public
event polling, cancellation, and automatic final transcript upload. Event
payloads are allowlisted and discard transcript content. See
`docs/browser-local-transcription.md` for the full design and limitations.

### Complete-channel ingestion

The home page accepts a complete YouTube channel URL. A separate channel-search
flow can find a channel when the user knows only its name.

The worker:

1. resolves the channel and uploads playlist;
2. discovers public uploads using the YouTube API when configured, otherwise
   `yt-dlp`;
3. sends deduplicated batches, normally 50 videos per batch;
4. processes caption jobs concurrently;
5. bounds ASR separately because it uses substantially more memory;
6. records completed, failed, queued, and processing counts;
7. records grouped failure reasons;
8. exposes elapsed time, estimated remaining time, workflow progress, and
   transcript coverage;
9. can refresh a completed channel to discover new uploads.

Default worker settings:

```text
WORKER_CONCURRENCY=4
ASR_CONCURRENCY=1
CHANNEL_BATCH_SIZE=50
```

### Worker

The owner-operated worker is `worker/transcript_worker.py`.

It can:

- claim video jobs;
- claim topic-discovery jobs;
- claim channel-search jobs;
- claim complete-channel jobs;
- fetch metadata and captions with `yt-dlp`;
- discover videos with the official YouTube API when `YOUTUBE_API_KEY` exists;
- run MLX Whisper on Apple Silicon;
- run a configured whisper.cpp binary;
- process caption work concurrently;
- report structured failures without crashing the poll loop.

The worker is deliberately separate from Vercel. Vercel stores and serves
results; a worker performs long-running discovery and transcription.

The macOS worker is currently managed by the LaunchAgent
`chatgpt.transcript-registry.worker`. Its configured Python and `yt-dlp`
executables live inside this repository's `.venv/`. Before removing or
recreating `.venv/`, unload the LaunchAgent. After rebuilding the environment,
restart it and confirm that it is running:

```sh
launchctl kickstart -k gui/$(id -u)/chatgpt.transcript-registry.worker
launchctl print gui/$(id -u)/chatgpt.transcript-registry.worker
```

## Data and migrations

- Drizzle schema: `db/schema.ts`
- Database access: `db/index.ts`, `db/runtime.ts`, `db/store.ts`
- Migrations: `drizzle/`
- Latest generated migration sequence ends at:
  `0006_cooing_cerebro.sql`

Run migrations with:

```sh
npm run db:migrate
```

Do not edit an already-applied migration. Add a new migration for schema
changes.

## Environment variables

The application expects these important production values:

- `DATABASE_URL`
- `WORKER_TOKEN`
- `CONTRIBUTION_SECRET`
- `RATE_LIMIT_SALT`

The owner worker expects:

- `REGISTRY_URL`
- `WORKER_TOKEN`
- `YT_DLP_BINARY`
- `ALLOW_AUDIO_FALLBACK`
- `PERMISSIONED_CHANNEL_IDS`
- `ASR_ENGINE`
- `WHISPER_CPP_BINARY`
- `WHISPER_CPP_MODEL`
- optional `YOUTUBE_API_KEY`
- optional concurrency variables shown above

Local secret files are ignored by Git. Never commit `.env.local`,
`.env.worker`, database credentials, Vercel tokens, or worker tokens.

## Local setup

Website:

```sh
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Worker:

```sh
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
cp worker/.env.example .env.worker
npm run worker
```

The repository requires Node.js 22.13 or newer. Vercel currently builds with
Node.js 24.x.

## Validation

Run all checks before committing or deploying:

```sh
npm run lint
npm test
```

`npm test` intentionally includes:

1. a production Next.js build;
2. JavaScript service tests;
3. TypeScript contribution-token tests;
4. Python contributor tests;
5. Python channel-worker tests.

Last local verification on 31 July 2026:

- ESLint: passed with no warnings or errors.
- Next.js production build: passed.
- JavaScript service integration tests: 17/18 passed; the existing persistent
  `Mayo Clinic` channel-search fixture returned a newly queued `202` rather
  than the test's assumed completed `200`.
- TypeScript contribution and event-validation tests: 4/4 passed.
- Python worker and contributor tests: 9/9 passed.

After deploying, verify at minimum:

```sh
curl -fsS https://transcript-registry.vercel.app/api/health
curl -fsS 'https://transcript-registry.vercel.app/search.json?q=diabetes&limit=3'
curl -fsS 'https://transcript-registry.vercel.app/search.txt?q=diabetes&limit=3'
curl -fsS 'https://transcript-registry.vercel.app/on-demand.json?url=Txqe_CAD43c'
curl -fsS https://transcript-registry.vercel.app/llms.txt
curl -fsS https://transcript-registry.vercel.app/robots.txt
curl -fsS https://transcript-registry.vercel.app/sitemap.xml
```

For a new deployment, also inspect it with:

```sh
npx --yes vercel@latest inspect DEPLOYMENT_URL --wait
npx --yes vercel@latest logs DEPLOYMENT_URL --level error --since 1h
```

## Safe production deployment

Verify ownership first:

```sh
npx --yes vercel@latest whoami
npx --yes vercel@latest project inspect transcript-registry \
  --scope aksh08022006s-projects
```

Expected identity is `aksh08022006`. Expected owner is
`aksh08022006's projects`.

Deploy a preview without changing the production alias:

```sh
npx --yes vercel@latest deploy --skip-domain \
  --scope aksh08022006s-projects
```

Verify the preview, then deploy the same committed tree to production:

```sh
npx --yes vercel@latest deploy --prod \
  --scope aksh08022006s-projects
```

Do not expose tokens in command arguments, logs, documentation, or commits.

## Important repository history

The feature implementation through local commit
`156ac9fdd8818d3822ef1071196876a909f29ef7` was validated and deployed.

The later GitHub merge commit `f349ee33a219e11f64c702706c058b83e8931f51`
accidentally used the reduced tree from a bad branch/main merge and removed
roughly 900 lines of channel coverage, on-demand, contributor, tests, and
worker functionality. The finalization change restores the validated files
onto the latest `main` base. Do not reintroduce the reduced tree from
`fde5203bf75220d0d325ccd5b3c615fbff3c56e3`.

## What is complete

- Public, ungated HTML/text/JSON transcripts
- Indexed full-text topic search
- Compact search snippets
- Agent-readable `llms.txt`, robots rules, and sitemap
- Automatic zero-result topic-discovery jobs
- One-video on-demand job API with polling
- Complete-channel ingestion
- Channel search
- Batched, deduplicated video queuing
- Concurrent caption processing with bounded ASR
- Public channel progress and real coverage reporting
- Grouped channel failure reasons
- Requesting-user local contribution protocol
- Browser-local Whisper contribution UI
- OPFS/IndexedDB pause and resume checkpoints
- Ordered, idempotent progress events and public event polling
- Progress, ETA, cancellation, and renewable job reservations
- WebGPU inference with WASM fallback
- Short-lived, video-bound contribution tokens
- Caption-first acquisition
- MLX Whisper and whisper.cpp local fallbacks
- Permanent reuse of contributed transcripts
- Neon-backed dynamic storage on Vercel
- Tests covering service, worker, and contribution behavior

## Current limitations

1. A Vercel request does not itself run Whisper. Browser-local transcription
   requires the user to select matching media and keep the browser available;
   the native owner/requester workers remain the unattended fallback.
2. Search ranks whole videos and returns one compact snippet per video. It does
   not yet expose a dedicated top-transcript-chunks endpoint for multiple
   timestamped passages within one video.
3. YouTube access can fail because of unavailable captions, private/deleted
   videos, age or region restrictions, bot checks, or upstream extractor
   changes. Failure reasons are recorded rather than silently hidden.
4. Audio transcription must only be enabled for sources the operator is
   permitted to process.
5. The current Postgres database stores complete transcript bodies. This is
   acceptable at the present size but object storage is cheaper at very large
   scale.
6. Browsers do not guarantee multi-hour background worker execution. Service
   workers cannot be used as reliable compute daemons; durability comes from
   local checkpoints, and closing the browser pauses work.
7. Registry can verify the public YouTube identity but cannot
   cryptographically prove that a user-selected local media file matches it.
8. `npm audit --omit=dev` currently reports five high-severity package entries
   rooted in `sharp` and Transformers.js's unused browser-path
   `onnxruntime-node`/`adm-zip` dependencies. Upstream packages do not currently
   offer a clean compatible resolution. Patched PostCSS is forced with an npm
   override, and the ASR package is imported only by the client worker.

## Next major project direction

The next context should productionize and exercise the browser path:

1. run migration `0006` in preview before deploying application code;
2. test Chrome, Edge, Firefox, and Safari with short and multi-hour media,
   including WebGPU device loss, WASM fallback, storage eviction, pause/resume,
   cancellation, grant rotation, and network interruption;
3. add CSP/model-host allowlists, feature flags, content-free telemetry, quota
   checks, and an explicit local-data management screen;
4. add transcript provenance/moderation defenses for the unresolved
   local-file-to-YouTube identity gap;
5. decide whether model assets should be pinned and served from a controlled
   origin;
6. expose the async job contract to a ChatGPT host integration so completion
   can schedule a continuation turn. Registry alone cannot wake or reinvoke an
   LLM conversation;
7. retain Commons/native workers for unsupported browsers and truly unattended
   execution.

The RFC also preserves hosted ASR and a native companion as alternatives; do
not build either by duplicating the mature Commons worker.

## Cleanup policy

Safe to recreate and remove when not in use:

- `.next/`
- `node_modules/`
- `.models/`
- Python `__pycache__/`
- `tsconfig.tsbuildinfo`
- ignored worker logs under `work/`

`.venv/` and `work/` are not disposable while the macOS LaunchAgent is
loaded. The LaunchAgent runs `.venv/bin/python`, `yt-dlp` is configured at
`.venv/bin/yt-dlp`, and its logs live under `work/`. If `.venv/` is removed,
recreate it with `python3 -m venv .venv` and install
`worker/requirements.txt` before restarting the worker.

Do not remove:

- source code;
- `drizzle/` migrations;
- `.env.local` or `.env.worker` unless their secrets have been backed up or
  intentionally rotated;
- `.vercel/project.json`, because it protects against deploying to the wrong
  Vercel account;
- Git history or unpushed commits.

## First commands in a new context

```sh
cd /Users/akshkaushik/Documents/YTLib
sed -n '1,360p' PROJECT_HANDOFF.md
git status -sb
git log -5 --oneline --decorate
npm run lint
npm test
```

Then verify the live health and search endpoints before making new changes.
