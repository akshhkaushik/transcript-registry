import { listTranscriptIds } from "../../db/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const transcripts = await listTranscriptIds();
  const urls = [
    `<url><loc>${escapeXml(origin)}</loc></url>`,
    `<url><loc>${escapeXml(`${origin}/contribute`)}</loc></url>`,
    ...transcripts.map(
      (transcript) =>
        `<url><loc>${escapeXml(`${origin}/youtube/${transcript.providerId}`)}</loc><lastmod>${escapeXml(transcript.updatedAt)}</lastmod></url>`,
    ),
  ];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
    {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-Robots-Tag": "index, follow",
      },
    },
  );
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&'"]/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[character] ?? character,
  );
}
