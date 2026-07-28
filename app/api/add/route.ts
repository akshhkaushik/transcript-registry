import {
  checkAndRecordSubmission,
  createOrFindJob,
  getTranscript,
} from "../../../db/store";
import { clientHash, jsonResponse } from "../../../lib/http";
import { resolveSource } from "../../../lib/youtube";

export const dynamic = "force-dynamic";

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

  const source = resolveSource(input);
  if (!source) {
    return respond(request, { error: "Enter a valid YouTube video URL." }, 400);
  }

  const transcript = await getTranscript(source.provider, source.providerId);
  if (transcript) {
    return redirectOrJson(request, `/youtube/${source.providerId}`, {
      status: "complete",
      transcript: `/youtube/${source.providerId}`,
      text: `/youtube/${source.providerId}.txt`,
      json: `/youtube/${source.providerId}.json`,
    });
  }

  if (!(await checkAndRecordSubmission(await clientHash(request)))) {
    return respond(
      request,
      { error: "Submission limit reached. Try again later." },
      429,
    );
  }

  const { job, created } = await createOrFindJob({
    provider: source.provider,
    providerId: source.providerId,
    sourceUrl: source.canonicalUrl,
  });
  return redirectOrJson(request, `/jobs/${job.id}`, {
    status: job.status,
    created,
    job: `/jobs/${job.id}.json`,
  }, 202);
}

function wantsJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.includes("application/json") === true ||
    request.headers.get("accept")?.includes("application/json") === true
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

function redirectOrJson(
  request: Request,
  location: string,
  body: unknown,
  status = 200,
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
