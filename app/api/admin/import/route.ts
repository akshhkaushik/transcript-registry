import { saveTranscript } from "../../../../db/store";
import { jsonResponse, workerAuthorized } from "../../../../lib/http";
import { coerceTranscript } from "../../../../lib/transcript";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!(await workerAuthorized(request))) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    records?: unknown;
  } | null;
  if (!body || !Array.isArray(body.records) || body.records.length > 20) {
    return jsonResponse(
      { error: "Send an array of at most 20 records" },
      { status: 400 },
    );
  }
  let imported = 0;
  const errors: Array<{ index: number; error: string }> = [];
  for (const [index, item] of body.records.entries()) {
    try {
      await saveTranscript(await coerceTranscript(item));
      imported += 1;
    } catch (error) {
      errors.push({
        index,
        error: error instanceof Error ? error.message : "Invalid record",
      });
    }
  }
  return jsonResponse({ imported, errors }, { status: errors.length ? 207 : 200 });
}
