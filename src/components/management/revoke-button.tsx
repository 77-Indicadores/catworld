"use client";
import { useState } from "react";
import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { useFeedback } from "@/components/ui/feedback";

export function RevokeButton({ url, label = "Revogar", confirmText, method = "DELETE" }: { url: string; label?: string; confirmText: string; method?: "DELETE" }) {
  const router = useRouter();
  const { confirm, notify } = useFeedback();
  const [loading, setLoading] = useState(false);
  async function revoke() {
    if (!await confirm({ title: label, message: confirmText, confirmLabel: label, danger: true })) return;
    setLoading(true);
    try {
      await apiRequest(url, { method });
      notify("success", "Feito.");
      router.refresh();
    } catch (e) {
      notify("error", errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  return <button onClick={revoke} disabled={loading} className="btn btn-ghost btn-xs text-error" aria-label={label}><Ban size={13} />{loading ? "Aguarde…" : label}</button>;
}
