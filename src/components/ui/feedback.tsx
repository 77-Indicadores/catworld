"use client";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { apiRequest, errorMessage } from "@/lib/api-client";

export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Ação irreversível: botão vermelho. */
  danger?: boolean;
  /** Exige digitar este texto para habilitar a confirmação (remoções de dados). */
  typeToConfirm?: string;
};
type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; text: string };
type Feedback = { confirm: (o: ConfirmOptions) => Promise<boolean>; notify: (kind: ToastKind, text: string) => void };

const Ctx = createContext<Feedback | null>(null);

/** Substitui confirm()/alert() nativos: diálogo com foco, Esc e consequência explícita; avisos com aria-live. */
export function useFeedback(): Feedback {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Fora do provider (testes/SSR isolado): degrada para o comportamento nativo em vez de quebrar.
    return {
      confirm: async (o) => (typeof window !== "undefined" ? window.confirm(`${o.title}${typeof o.message === "string" ? `\n${o.message}` : ""}`) : false),
      notify: (_k, text) => { if (typeof window !== "undefined") window.alert(text); },
    };
  }
  return ctx;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve })), []);
  const notify = useCallback((kind: ToastKind, text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    if (kind !== "error") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const value = useMemo(() => ({ confirm, notify }), [confirm, notify]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog && <ConfirmModal {...dialog} onClose={(v) => { dialog.resolve(v); setDialog(null); }} />}
      <div className="toast toast-end z-[70]" role="region" aria-label="Avisos">
        {toasts.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`alert ${t.kind === "error" ? "alert-error" : t.kind === "success" ? "alert-success" : "alert-info"} max-w-sm text-sm shadow-lg`}>
            {t.kind === "success" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span className="whitespace-normal">{t.text}</span>
            <button className="btn btn-ghost btn-xs btn-circle" aria-label="Fechar aviso" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ConfirmModal({ title, message, confirmLabel = "Confirmar", cancelLabel = "Cancelar", danger, typeToConfirm, onClose }: ConfirmOptions & { onClose: (v: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState("");
  const ok = !typeToConfirm || typed === typeToConfirm;

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(false); }}>
      <div className="modal-box">
        <h3 id={titleId} className="text-lg font-bold">{title}</h3>
        {message && <div className="mt-2 text-sm text-base-content/75">{message}</div>}
        {typeToConfirm && (
          <label className="form-control mt-4 block">
            <span className="text-sm">Digite <b className="font-mono">{typeToConfirm}</b> para confirmar</span>
            <input autoFocus className="input input-bordered mt-1 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="modal-action">
          <button className="btn btn-ghost" onClick={() => onClose(false)} autoFocus={!typeToConfirm}>{cancelLabel}</button>
          <button className={`btn ${danger ? "btn-error" : "btn-primary"}`} disabled={!ok} onClick={() => onClose(true)}>{confirmLabel}</button>
        </div>
      </div>
      <div className="modal-backdrop bg-black/40" onClick={() => onClose(false)} />
    </dialog>
  );
}

/**
 * Executa uma chamada de escrita na API e avisa o resultado: sucesso (opcional) ou o erro em português.
 * Devolve true só se a API confirmou — nunca "some" o botão em silêncio numa falha.
 */
export function useApiAction() {
  const { notify } = useFeedback();
  return useCallback(async (url: string, init: RequestInit, successMessage?: string): Promise<boolean> => {
    try {
      await apiRequest(url, init);
      if (successMessage) notify("success", successMessage);
      return true;
    } catch (e) {
      notify("error", errorMessage(e));
      return false;
    }
  }, [notify]);
}
