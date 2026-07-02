import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://bb755e3383de24d77643783f7a0548c7@o4511632763191296.ingest.us.sentry.io/4511667776782337",

  tracesSampleRate: 1,
  enableLogs: true,
});
