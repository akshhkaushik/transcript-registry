import { GET as service } from "../api/on-demand/route";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.searchParams.set("format", "txt");
  return service(new Request(url, request));
}
