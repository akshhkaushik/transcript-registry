import type { Provider } from "./types";

export type ResolvedSource = {
  provider: Provider;
  providerId: string;
  canonicalUrl: string;
};

export type ResolvedChannel = {
  inputUrl: string;
  normalizedUrl: string;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function resolveSource(input: string): ResolvedSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (VIDEO_ID.test(trimmed)) {
    return youtube(trimmed);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id: string | null = null;

  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const [kind, candidate] = url.pathname.split("/").filter(Boolean);
      if (kind === "shorts" || kind === "live" || kind === "embed") {
        id = candidate ?? null;
      }
    }
  }

  return id && VIDEO_ID.test(id) ? youtube(id) : null;
}

export function resolveChannelSource(input: string): ResolvedChannel | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com" && host !== "m.youtube.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const [kind, value] = parts;
  const supported =
    (kind?.startsWith("@") && kind.length > 1) ||
    (["channel", "user", "c"].includes(kind ?? "") && Boolean(value));
  if (!supported) return null;
  const baseParts = kind?.startsWith("@") ? [kind] : [kind, value];
  const normalizedUrl = `https://www.youtube.com/${baseParts.join("/")}`;
  return { inputUrl: url.toString(), normalizedUrl };
}

function youtube(providerId: string): ResolvedSource {
  return {
    provider: "youtube",
    providerId,
    canonicalUrl: `https://www.youtube.com/watch?v=${providerId}`,
  };
}
