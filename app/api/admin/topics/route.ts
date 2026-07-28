import { createOrRefreshTopicJob } from "../../../../db/store";
import { jsonResponse, workerAuthorized } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    topics?: unknown;
    targetCount?: unknown;
    force?: unknown;
  } | null;
  if (
    !body ||
    !Array.isArray(body.topics) ||
    !body.topics.length ||
    body.topics.length > 50
  ) {
    return jsonResponse(
      { error: "Send an array of 1 to 50 topic strings" },
      { status: 400 },
    );
  }
  const targetCount = Number(body.targetCount) || 8;
  const force = body.force === true;
  try {
    const jobs = await Promise.all(
      body.topics.map((topic) => {
        if (typeof topic !== "string") {
          throw new Error("Every topic must be a string");
        }
        return createOrRefreshTopicJob(topic, targetCount, force);
      }),
    );
    return jsonResponse({
      accepted: jobs.length,
      created: jobs.filter((item) => item.created).length,
      refreshed: jobs.filter((item) => item.refreshed).length,
      jobs: jobs.map((item) => ({
        id: item.job.id,
        query: item.job.query,
        status: item.job.status,
      })),
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Invalid topics" },
      { status: 400 },
    );
  }
}
