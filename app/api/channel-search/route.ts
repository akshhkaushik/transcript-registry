import {
  checkAndRecordSubmission,
  createOrRefreshChannelSearchJob,
  getChannelSearchJobForQuery,
  meaningfulTokens,
} from "../../../db/store";
import { clientHash, jsonResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return findChannels(request, url.searchParams.get("q") ?? "");
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let query = "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      q?: unknown;
      query?: unknown;
    } | null;
    query =
      typeof body?.q === "string"
        ? body.q
        : typeof body?.query === "string"
          ? body.query
          : "";
  } else {
    const form = await request.formData();
    query = String(form.get("q") ?? form.get("query") ?? "");
  }
  return findChannels(request, query);
}

async function findChannels(
  request: Request,
  input: string,
): Promise<Response> {
  const query = input.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!meaningfulTokens(query).length) {
    return respond(
      request,
      { error: "Enter a specific YouTube channel name or topic." },
      400,
    );
  }
  const existing = await getChannelSearchJobForQuery(query);
  if (!existing) {
    const allowed = await checkAndRecordSubmission(
      await clientHash(request),
      10,
    );
    if (!allowed) {
      return respond(
        request,
        { error: "Channel search limit reached. Try again later." },
        429,
      );
    }
  }
  const result = await createOrRefreshChannelSearchJob(query, 8);
  const path = `/channel-searches/${result.job.id}`;
  const body = {
    status: result.job.status,
    created: result.created,
    refreshed: result.refreshed,
    query: result.job.query,
    results: result.job.results,
    page: path,
    json: `${path}.json`,
    retryAfterSeconds:
      result.job.status === "queued" || result.job.status === "processing"
        ? 10
        : null,
  };
  if (wantsJson(request)) {
    return jsonResponse(body, {
      status:
        result.job.status === "queued" || result.job.status === "processing"
          ? 202
          : 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.redirect(new URL(path, request.url), 303);
}

function wantsJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.includes("application/json") === true ||
    request.headers.get("accept")?.includes("application/json") === true ||
    request.method === "GET"
  );
}

function respond(request: Request, body: unknown, status: number): Response {
  if (wantsJson(request)) return jsonResponse(body, { status });
  return new Response(
    `<!doctype html><html><body><main><p>${escapeHtml(
      (body as { error: string }).error,
    )}</p><p><a href="/">Back</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
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
