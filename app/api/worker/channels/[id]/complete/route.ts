import { completeChannelDiscovery } from "../../../../../../db/store";
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
  try {
    await completeChannelDiscovery(id);
    return jsonResponse({ status: "processing" });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Completion failed" },
      { status: 400 },
    );
  }
}
