"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyableId({ value, label = "ID" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-md bg-base-200 px-2 py-1 font-mono text-xs text-base-content/60 hover:bg-base-300" title="Copiar ID">
      <span>{label}: {value}</span>
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </button>
  );
}
