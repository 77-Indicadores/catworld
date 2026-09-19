"use client";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/use-copy";

/** Linha compacta "label: id" usada na árvore do workspace (sidebar estreita) — visual diferente de
 * CopyableId (chip) e CopyField (botão largo), mas reaproveita a mesma lógica de cópia. */
export function CopyId({ label, id, className }: { label: string; id: string; className?: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      onClick={() => copy(id)}
      title={`Copiar ${label} ID`}
      className={"group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px] text-base-content/65 transition-colors hover:bg-base-200 hover:text-base-content/65 " + (className ?? "")}
    >
      {copied ? <Check size={10} className="shrink-0 text-success" /> : <Copy size={10} className="shrink-0 opacity-0 group-hover:opacity-100" />}
      <span className="font-mono truncate">{label}: {id}</span>
    </button>
  );
}
