import { GET as search } from "../api/search/route";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.searchParams.set("format", "json");
  return search(new Request(url, request));
}
