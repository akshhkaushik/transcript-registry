import { claimTopicJob } from "../../../../../db/store";
import { jsonResponse, workerAuthorized } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    workerId?: unknown;
  };
  const workerId =
    typeof body.workerId === "string" && body.workerId.trim()
      ? body.workerId.trim().slice(0, 200)
      : "worker";
  const job = await claimTopicJob(workerId);
  return jsonResponse({ job }, { headers: { "Cache-Control": "no-store" } });
}
