import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { execSync } from "node:child_process";

function gitCommit() {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore","pipe","ignore"] }).toString().trim(); }
  catch { return "unknown"; }
}

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_GIT_COMMIT: gitCommit() },
  reactStrictMode: true,
  output: "standalone",
  // Pacotes com binários nativos (.node): o webpack não sabe empacotá-los e falha o build
  // (ex.: ssh2/mssql/@node-rs/argon2/@duckdb/node-api). Mantê-los fora do bundle do servidor.
  serverExternalPackages: ["ssh2", "mssql", "@node-rs/argon2", "@duckdb/node-api"],
  experimental: {
    // Default is 10 MB — data files routinely exceed this.
    // Valor fixo de build (nao acompanha o banco): teto alto de seguranca, igual a UPLOAD_HARD_CEILING_BYTES em
    // server/worker/config.ts. O limite REAL de upload fica em Configuracoes > Worker e e aplicado pela rota.
    proxyClientMaxBodySize: 2 * 1024 * 1024 * 1024,
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "webcrafters-5h",

  project: "catworld",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
