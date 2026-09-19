"use client";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * Confirmação proporcional ao risco para ações irreversíveis: só habilita o botão quando o
 * usuário digita `confirmValue` exatamente. Use para hard delete e outras ações sem volta —
 * não para ações reversíveis (essas usam `useFeedback().confirm`).
 */
export function DangerZone({
  description,
  confirmValue,
  confirmLabel = "Excluir definitivamente",
  busyLabel = "Processando...",
  onConfirm,
  busy = false,
  error,
}: {
  description: string;
  confirmValue: string;
  confirmLabel?: string;
  busyLabel?: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  error?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="mt-6 rounded-xl border border-error/30 bg-error/5 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-error">
        <TriangleAlert size={15} />
        Zona de perigo
      </p>
      <p className="mt-1 text-xs text-base-content/65">{description}</p>
      <p className="mt-3 text-xs">
        Digite <span className="font-mono font-semibold">{confirmValue}</span> para confirmar:
      </p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="input input-sm mt-2 w-full"
        placeholder={confirmValue}
        aria-label={`Digite "${confirmValue}" para confirmar`}
      />
      <button
        type="button"
        onClick={() => onConfirm()}
        disabled={value !== confirmValue || busy}
        className="btn btn-error btn-sm mt-3 w-full"
      >
        {busy ? busyLabel : confirmLabel}
      </button>
      {error && <p role="alert" className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
