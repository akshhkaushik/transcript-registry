/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKER_TOKEN?: string;
  RATE_LIMIT_SALT?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    (
      globalThis as typeof globalThis & {
        __TRANSCRIPT_ENV__?: Env;
      }
    ).__TRANSCRIPT_ENV__ = env;
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const rewritten = rewriteMachineRoute(url);
    if (rewritten) {
      return handler.fetch(
        new Request(new URL(rewritten, request.url), request),
        env,
        ctx,
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

function rewriteMachineRoute(url: URL): string | null {
  const transcript = url.pathname.match(
    /^\/youtube\/([A-Za-z0-9_-]{11})\.(txt|json)$/,
  );
  if (transcript) {
    return `/api/transcripts/youtube/${transcript[1]}?format=${transcript[2]}`;
  }
  if (url.pathname === "/search.txt" || url.pathname === "/search.json") {
    const format = url.pathname.endsWith(".txt") ? "txt" : "json";
    const query = url.searchParams.toString();
    return `/api/search?${query}${query ? "&" : ""}format=${format}`;
  }
  const job = url.pathname.match(/^\/jobs\/([A-Za-z0-9-]+)\.json$/);
  if (job) return `/api/jobs/${job[1]}`;
  return null;
}
