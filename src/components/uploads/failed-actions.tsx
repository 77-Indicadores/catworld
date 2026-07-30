"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";

export function FailedActions({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"retry" | "dismiss" | null>(null);

  if (count === 0) return null;

  async function retryAll() {
    setBusy("retry");
    await fetch("/api/v1/uploads/retry-failed", { method: "POST" });
    router.refresh();
    setBusy(null);
  }

  async function dismissAll() {
    setBusy("dismiss");
    await fetch("/api/v1/uploads/dismiss-failed", { method: "POST" });
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="flex items-center justify-between rounded-box border border-error/30 bg-error/5 px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm text-error">
        <AlertTriangle size={14} />
        <span>{count} {count === 1 ? "job falhou" : "jobs falharam"}</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={retryAll}
          disabled={!!busy}
          className="btn btn-xs btn-outline btn-primary gap-1"
        >
          {busy === "retry" ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Reinfileirar todos
        </button>
        <button
          onClick={dismissAll}
          disabled={!!busy}
          className="btn btn-xs btn-ghost gap-1 text-base-content/45"
        >
          {busy === "dismiss" ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
          Descartar
        </button>
      </div>
    </div>
  );
}
