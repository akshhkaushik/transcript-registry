import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ];
  },
};

export default nextConfig;
