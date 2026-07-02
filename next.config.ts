import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Default is 10 MB — data files routinely exceed this.
    // Set to 500 MB; override via CATWORLD_UPLOAD_MAX_BYTES env if needed.
    proxyClientMaxBodySize: Number(process.env.CATWORLD_UPLOAD_MAX_BYTES ?? 500 * 1024 * 1024),
  },
};

export default withSentryConfig(nextConfig, {
  org: "webcrafters-5h",
  project: "catworld",

  silent: !process.env.CI,

  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: true,
});
