"use client";
import type { Freshness } from "@/lib/present";

const COLOR: Record<Freshness["tone"], string> = {
  healthy: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  inactive: "bg-base-content/30",
};

/** Ponto de estado (frescor) para listas apertadas: cor + nome acessível (não depende só da cor). */
export function FreshnessDot({ freshness, className = "" }: { freshness: Freshness; className?: string }) {
  const text = freshness.reason ? `${freshness.label}: ${freshness.reason}` : freshness.label;
  return <span role="img" aria-label={freshness.label} title={text} className={`inline-block size-2 shrink-0 rounded-full ${COLOR[freshness.tone]} ${className}`} />;
}
