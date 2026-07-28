# Transcript Registry

This is a public transcript service made for web-searching AI tools.

Live site: https://transcript-registry.vercel.app

People only paste a missing YouTube link. The central worker then:

1. uses creator captions when available;
2. otherwise uses automatic captions;
3. when permitted, transcribes the audio locally with MLX Whisper or whisper.cpp;
4. stores the result for everyone.

Every transcript is available as a normal page, plain text, and JSON. Search
returns only real matches; unrelated queries return zero results.

## Run it

Copy `.env.example` to `.env.worker` and fill in the public site address and
worker secret. Start the website locally with:

```sh
npm install
npm run dev
```

Run the owner-operated background worker separately:

```sh
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
npm run worker
```

Install `ffmpeg` and `whisper.cpp` separately if you want the permissioned
audio fallback. MLX Whisper is optional. Captioned videos need only `yt-dlp`,
which the requirements file installs.

The launch corpus comes from the attributed CC-BY
[YouTube-Commons dataset](https://huggingface.co/datasets/PleIAs/YouTube-Commons).

## Useful URLs

- `/search.txt?q=topic`
- `/youtube/VIDEO_ID`
- `/youtube/VIDEO_ID.txt`
- `/youtube/VIDEO_ID.json`
- `/llms.txt`

Reading never requires an account.
