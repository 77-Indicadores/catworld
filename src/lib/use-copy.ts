"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Lógica repetida em toda UI de "copiar valor" do app: escreve na área de transferência e mostra
 * feedback por um tempo curto. Cada tela mantém seu próprio visual (pill, botão largo, linha da
 * sidebar) — só a mecânica de copiar é compartilhada. */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    } catch {
      // sem permissão de área de transferência: o texto continua selecionável na tela
    }
  }, [resetMs]);

  return { copied, copy };
}
