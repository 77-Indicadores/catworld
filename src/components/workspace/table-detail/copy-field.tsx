"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Valor copiável com rótulo (nome SQL, URL, trecho de código). O botão tem nome acessível e confirma a cópia. */
export function CopyField({ label, value, block = false }: { label: string; value: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // sem permissão de área de transferência: o texto continua selecionável na tela
    }
  }

  return (
    <div className="text-xs">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className="text-base-content/70">{label}</span>
        <button type="button" onClick={copy} className="btn btn-ghost btn-xs gap-1" aria-label={`Copiar ${label}`}>
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          <span aria-live="polite">{copied ? "Copiado" : "Copiar"}</span>
        </button>
      </div>
      {block ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-base-200 p-2 font-mono text-[11px] leading-relaxed">{value}</pre>
      ) : (
        <code className="block break-all rounded bg-base-200 px-2 py-1 font-mono text-[11px]">{value}</code>
      )}
    </div>
  );
}
