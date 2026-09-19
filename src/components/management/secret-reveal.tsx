"use client";
import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useFeedback } from "@/components/ui/feedback";

/**
 * Exibe um segredo gerado UMA vez (token, senha de usuário SQL). Só libera o "Concluir" depois que a pessoa
 * confirma que guardou: fechar sem copiar perderia o segredo para sempre.
 */
export function SecretReveal({ secret, title = "Acesso criado", onDone }: { secret: string; title?: string; onDone: () => void }) {
  const { notify } = useFeedback();
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      notify("success", "Segredo copiado.");
    } catch {
      setShow(true);
      notify("error", "Não foi possível copiar automaticamente. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <div>
      <h3 className="text-center text-xl font-bold">{title}</h3>
      <p className="mt-1 text-center text-sm text-base-content/70">Copie o segredo agora. Ele não será exibido de novo; se perder, será preciso gerar outro.</p>
      <div className="join mt-5 flex">
        <input readOnly aria-label="Segredo" value={show ? secret : "•".repeat(24)} className="input join-item min-w-0 flex-1 font-mono" onFocus={(e) => show && e.currentTarget.select()} />
        <button className="btn join-item" onClick={() => setShow(!show)} aria-label={show ? "Ocultar segredo" : "Mostrar segredo"}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        <button className="btn btn-primary join-item" onClick={copy} aria-label="Copiar segredo">{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      </div>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="checkbox checkbox-sm" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        Já guardei o segredo em um lugar seguro
      </label>
      <div className="modal-action">
        <button className="btn btn-primary btn-sm" disabled={!saved} onClick={onDone}>Concluir</button>
      </div>
    </div>
  );
}
