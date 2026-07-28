# Transcript Registry

A free public library of YouTube transcripts, built for ChatGPT, Claude, search
engines, and people. No account is needed to read anything.

Live site: https://transcript-registry.vercel.app

## How it works

1. Search `/search.txt?q=your+topic`.
2. Open a result such as `/youtube/VIDEO_ID.txt`.
3. If a video is missing, paste its YouTube link on the home page.
4. A background worker gets existing captions first. If captions are missing
   and the source is permitted, it can transcribe audio with MLX Whisper or
   whisper.cpp.
5. The transcript is saved in Neon and stays available as HTML, plain text,
   and JSON.

Useful public URLs:

- `/search.txt?q=topic`
- `/search.json?q=topic`
- `/youtube/VIDEO_ID`
- `/youtube/VIDEO_ID.txt`
- `/youtube/VIDEO_ID.json`
- `/llms.txt`

## Run the website locally

Copy `.env.example` to `.env.local`. Add a PostgreSQL `DATABASE_URL` and two
private random values for `WORKER_TOKEN` and `RATE_LIMIT_SALT`, then run:

```sh
npm install
npm run db:migrate
npm run dev
```

## Run a transcript worker

The worker can run on any computer; it does not need to run on the web server.
Copy `worker/.env.example` to `.env.worker`, use the same `WORKER_TOKEN`, then:

```sh
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
npm run worker
```

Captioned videos only need `yt-dlp`. For permitted audio transcription, install
MLX Whisper on Apple Silicon or configure whisper.cpp.
