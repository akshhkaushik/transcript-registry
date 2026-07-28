import { GET as service } from "../api/on-demand/route";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return service(request);
}
