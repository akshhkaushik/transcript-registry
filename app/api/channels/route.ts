import {
  checkAndRecordSubmission,
  createOrRefreshChannelJob,
  listChannelProgress,
} from "../../../db/store";
import { clientHash, jsonResponse } from "../../../lib/http";
import { resolveChannelSource } from "../../../lib/youtube";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return jsonResponse(
    { channels: await listChannelProgress(100) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let input = "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    input = typeof body?.url === "string" ? body.url : "";
  } else {
    const form = await request.formData();
    input = String(form.get("url") ?? "");
  }
  const channel = resolveChannelSource(input);
  if (!channel) {
    return respond(
      request,
      {
        error:
          "Enter a YouTube channel URL such as youtube.com/@handle or youtube.com/channel/UC…",
      },
      400,
    );
  }
  if (!(await checkAndRecordSubmission(await clientHash(request), 3))) {
    return respond(
      request,
      { error: "Channel submission limit reached. Try again later." },
      429,
    );
  }
  const result = await createOrRefreshChannelJob(channel);
  return redirectOrJson(
    request,
    `/channels/${result.job.id}`,
    {
      status: result.job.status,
      created: result.created,
      refreshed: result.refreshed,
      channel: `/channels/${result.job.id}`,
      json: `/channels/${result.job.id}.json`,
    },
    202,
  );
}

function wantsJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.includes("application/json") === true ||
    request.headers.get("accept")?.includes("application/json") === true
  );
}

function respond(request: Request, body: unknown, status: number): Response {
  if (wantsJson(request)) return jsonResponse(body, { status });
  const error = escapeHtml((body as { error: string }).error);
  return new Response(
    `<!doctype html><html><body><main><p>${error}</p><p><a href="/">Back</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function redirectOrJson(
  request: Request,
  location: string,
  body: unknown,
  status: number,
): Response {
  if (wantsJson(request)) return jsonResponse(body, { status });
  return Response.redirect(new URL(location, request.url), 303);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
