"use client";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/lib/use-copy";

export function CopyableId({ value, label = "ID" }: { value: string; label?: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button onClick={() => copy(value)} className="inline-flex items-center gap-1.5 rounded-md bg-base-200 px-2 py-1 font-mono text-xs text-base-content/65 hover:bg-base-300" title="Copiar ID">
      <span>{label}: {value}</span>
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </button>
  );
}
