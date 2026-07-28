import { transcriptResponse } from "../route";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  const { videoId } = await context.params;
  return transcriptResponse(videoId, "txt");
}
