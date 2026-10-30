import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const localApi = process.env.LOCAL_PYTHON_API;
    if (process.env.NODE_ENV !== "development" || !localApi) return [];
    return [{ source: "/api/recognize", destination: `${localApi}/api/recognize` }];
  },
};

export default nextConfig;
