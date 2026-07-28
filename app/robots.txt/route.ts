import { textResponse } from "../../lib/http";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return textResponse(
    [
      "User-agent: OAI-SearchBot",
      "Allow: /",
      "",
      "User-agent: ChatGPT-User",
      "Allow: /",
      "",
      "User-agent: Claude-SearchBot",
      "Allow: /",
      "",
      "User-agent: Claude-User",
      "Allow: /",
      "",
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
    ].join("\n"),
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
