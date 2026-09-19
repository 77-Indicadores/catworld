"use client";
import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { useFeedback } from "@/components/ui/feedback";
import { SecretReveal } from "./secret-reveal";

export function RotateButton({ id }: { id: string }) {
  const router = useRouter();
  const { confirm, notify } = useFeedback();
  const ref = useRef<HTMLDialogElement>(null);
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);

  async function rotate() {
    if (!await confirm({
      title: "Rotacionar senha",
      message: "A senha atual deste usuário SQL deixa de funcionar imediatamente. Quem usa a senha antiga (relatórios, aplicações) precisará da nova.",
      confirmLabel: "Rotacionar",
      danger: true,
    })) return;
    setLoading(true);
    try {
      const { data } = await apiRequest<{ secret: string }>(`/api/v1/database-users/${id}/rotate`, { method: "POST" });
      setSecret(data.secret);
      ref.current?.showModal();
    } catch (e) {
      notify("error", errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function done() {
    ref.current?.close();
    setSecret("");
    router.refresh(); // só depois de a pessoa guardar o segredo
  }

  return (
    <>
      <button onClick={rotate} disabled={loading} className="btn btn-ghost btn-xs" aria-label="Rotacionar senha"><RefreshCw size={13} />{loading ? "Aguarde…" : "Rotacionar"}</button>
      {/* Esc não fecha enquanto o segredo está na tela. */}
      <dialog ref={ref} className="modal" aria-label="Nova senha gerada" onCancel={(e) => e.preventDefault()}>
        <div className="modal-box">{secret && <SecretReveal secret={secret} title="Nova senha gerada" onDone={done} />}</div>
      </dialog>
    </>
  );
}
