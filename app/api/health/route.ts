import { getCounts } from "../../../db/store";
import { jsonResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const counts = await getCounts();
  return jsonResponse({
    ok: true,
    service: "transcript-registry",
    ...counts,
    time: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
