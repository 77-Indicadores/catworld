import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fuso do processo web em UTC (FON-03/ENT-06): datas e timestamps não dependem do fuso do host.
    (await import("./src/server/runtime-tz")).ensureUtcTimezone();
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
