"use client";
import { useId, useState, type ReactNode } from "react";
import { useDialog, ModalBackdrop } from "./modal";

/**
 * Padrão comum de criar/editar do app: trigger + dialog + form + erro + Cancelar/Salvar, fechando
 * sozinho quando `onSubmit` resolve sem lançar. Não tenta gerar os campos — cada uso continua livre
 * pra desenhar seu próprio formulário em `children`; só a mecânica ao redor é compartilhada.
 */
export function FormDialog({
  trigger,
  title,
  subtitle,
  children,
  afterForm,
  submitLabel,
  savingLabel,
  onSubmit,
  maxWidth = "max-w-lg",
}: {
  trigger: (open: () => void) => ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Conteúdo extra dentro da dialog, fora do <form> (ex.: uma zona de perigo). Recebe `close` para poder fechar a dialog após uma ação própria bem-sucedida. */
  afterForm?: (close: () => void) => ReactNode;
  submitLabel: string;
  savingLabel?: string;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => Promise<void> | void;
  maxWidth?: string;
}) {
  const { ref, open, close } = useDialog();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();

  function openReset() {
    setError("");
    open();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true); setError("");
    const form = e.currentTarget;
    try {
      await onSubmit(e);
      form.reset();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {trigger(openReset)}
      <dialog ref={ref} className="modal" aria-labelledby={titleId}>
        <div className={`modal-box ${maxWidth}`}>
          <form onSubmit={handleSubmit}>
            <h3 id={titleId} className="text-lg font-bold">{title}</h3>
            {subtitle && <p className="mt-1 text-sm text-base-content/65">{subtitle}</p>}
            <div className="mt-5 space-y-4">{children}</div>
            {error && <div role="alert" className="alert alert-error alert-soft mt-4">{error}</div>}
            <div className="modal-action">
              <button type="button" onClick={close} className="btn btn-ghost btn-sm">Cancelar</button>
              <button className="btn btn-primary btn-sm" disabled={saving}>{saving ? (savingLabel ?? "Salvando…") : submitLabel}</button>
            </div>
          </form>
          {afterForm?.(close)}
        </div>
        <ModalBackdrop onClose={close} />
      </dialog>
    </>
  );
}
