import {
  completeChannelSearchJob,
  getChannelSearchJob,
} from "../../../../../../db/store";
import {
  jsonResponse,
  workerAuthorized,
} from "../../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const job = await getChannelSearchJob(id);
  if (!job) {
    return jsonResponse(
      { error: "Channel search job not found" },
      { status: 404 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    channels?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.channels) ||
    body.channels.length > job.resultLimit
  ) {
    return jsonResponse(
      { error: `Send at most ${job.resultLimit} channel results` },
      { status: 400 },
    );
  }
  const channels = body.channels
    .map((value) => value as Record<string, unknown>)
    .filter(
      (value) =>
        typeof value.channelId === "string" &&
        typeof value.name === "string",
    )
    .map((value) => ({
      channelId: String(value.channelId),
      name: String(value.name),
      url: typeof value.url === "string" ? value.url : "",
      description:
        typeof value.description === "string" ? value.description : "",
    }));
  await completeChannelSearchJob(id, channels);
  return jsonResponse({ status: "complete", channels });
}
