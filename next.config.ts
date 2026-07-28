import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/contribute.:extension(py|sh)",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, follow" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/youtube/:videoId.txt",
        destination: "/api/transcripts/youtube/:videoId/txt",
      },
      {
        source: "/youtube/:videoId.json",
        destination: "/api/transcripts/youtube/:videoId/json",
      },
      {
        source: "/jobs/:id.json",
        destination: "/api/jobs/:id",
      },
      {
        source: "/topics/:id.json",
        destination: "/api/topics/:id",
      },
      {
        source: "/channels/:id.json",
        destination: "/api/channels/:id",
      },
      {
        source: "/channel-searches/:id.json",
        destination: "/api/channel-searches/:id",
      },
    ];
  },
};

export default nextConfig;
