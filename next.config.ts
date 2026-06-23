import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Default is 10 MB — data files routinely exceed this.
    // Set to 500 MB; override via CATWORLD_UPLOAD_MAX_BYTES env if needed.
    proxyClientMaxBodySize: Number(process.env.CATWORLD_UPLOAD_MAX_BYTES ?? 500 * 1024 * 1024),
  },
};

export default nextConfig;
