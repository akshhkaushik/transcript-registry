import { saveTranscripts } from "../../../../db/store";
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
  try {
    const transcripts = await Promise.all(
      body.records.map((record) => coerceTranscript(record)),
    );
    await saveTranscripts(transcripts);
    return jsonResponse({ imported: transcripts.length, errors: [] });
  } catch (error) {
    return jsonResponse(
      {
        imported: 0,
        errors: [
          {
            error: error instanceof Error ? error.message : "Invalid record",
          },
        ],
      },
      { status: 400 },
    );
  }
}
