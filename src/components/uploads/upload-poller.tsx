"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const ACTIVE_STATUSES = new Set([
  "PENDING_UPLOAD",
  "QUEUED_PREVIEW",
  "PREVIEWING",
  "QUEUED_IMPORT",
  "IMPORTING",
  "RETRYING",
  // SOURCE_REFRESH job statuses
  "QUEUED",
  "RUNNING",
]);

const POLL_INTERVAL = 10_000;

export function UploadPoller({ statuses }: { statuses: string[] }) {
  const router = useRouter();
  const hasActive = statuses.some((s) => ACTIVE_STATUSES.has(s));

  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL);
    return () => clearInterval(id);
  }, [hasActive, router]);

  return null;
}
