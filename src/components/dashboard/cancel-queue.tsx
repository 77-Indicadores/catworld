"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleX } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { useFeedback } from "@/components/ui/feedback";

export function CancelQueueButton({ queued }: { queued: number }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();
  const { confirm, notify } = useFeedback();

  if (queued === 0 || done) return null;

  const handleCancel = async () => {
    if (!await confirm({
      title: "Cancelar a fila de uploads",
      message: `${queued} upload(s) aguardando serão cancelados. Quem enviou precisará enviar de novo.`,
      confirmLabel: "Cancelar fila",
      danger: true,
    })) return;
    setLoading(true);
    try {
      await apiRequest("/api/v1/uploads/cancel-all", { method: "POST" });
      setDone(true); // só some se a API confirmou
      notify("success", "Fila cancelada.");
      router.refresh();
    } catch (e) {
      notify("error", errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className="btn btn-error btn-outline btn-sm gap-1"
      onClick={handleCancel}
      disabled={loading}
    >
      <CircleX size={14} />
      {loading ? "Cancelando..." : `Cancelar fila (${queued})`}
    </button>
  );
}
