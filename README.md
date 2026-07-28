# Transcript Registry

This is a public transcript service made for web-searching AI tools.

People only paste a missing YouTube link. The central worker then:

1. uses creator captions when available;
2. otherwise uses automatic captions;
3. when permitted, transcribes the audio locally with MLX Whisper or whisper.cpp;
4. stores the result for everyone.

Every transcript is available as a normal page, plain text, and JSON. Search
returns only real matches; unrelated queries return zero results.

## Run it

Copy `.env.example` to `.env`, fill in the public site address and secret, then:

```sh
npm install
npm run dev
```

Run the owner-operated background worker separately:

```sh
pip install mlx-whisper
npm run worker
```

`yt-dlp` and `ffmpeg` must be installed. Audio transcription is limited by
default to Creative Commons videos or channel IDs you explicitly allow.

The launch corpus comes from the attributed CC-BY
[YouTube-Commons dataset](https://huggingface.co/datasets/PleIAs/YouTube-Commons).

## Useful URLs

- `/search.txt?q=topic`
- `/youtube/VIDEO_ID`
- `/youtube/VIDEO_ID.txt`
- `/youtube/VIDEO_ID.json`
- `/llms.txt`

Reading never requires an account.
