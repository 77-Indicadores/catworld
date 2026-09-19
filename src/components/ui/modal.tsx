"use client";
import { useCallback, useRef } from "react";

/**
 * Elimina o boilerplate repetido em toda dialog do app: ref + showModal()/close().
 * Não tenta abstrair o conteúdo do formulário (cada dialog tem campos próprios) —
 * só a mecânica de abrir/fechar o `<dialog>` nativo.
 */
export function useDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const open = useCallback(() => ref.current?.showModal(), []);
  const close = useCallback(() => ref.current?.close(), []);
  return { ref, open, close };
}

/** Form padrão do DaisyUI para fechar a dialog ao clicar fora (backdrop). */
export function ModalBackdrop({ onClose, label = "Fechar" }: { onClose: () => void; label?: string }) {
  return (
    <form method="dialog" className="modal-backdrop">
      <button aria-label={label} onClick={onClose}>fechar</button>
    </form>
  );
}
