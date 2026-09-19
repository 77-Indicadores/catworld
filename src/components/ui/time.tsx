"use client";
import { useSyncExternalStore } from "react";
import { presentDateTime, type DateTimeOptions } from "@/lib/present";

const subscribe = () => () => undefined;

/**
 * Data e hora no fuso do navegador, com o UTC no tooltip. Renderiza só o ISO no servidor e a versão local depois de
 * montar (evita erro de hidratação: o servidor não sabe o fuso de quem está vendo).
 */
export function Time({ iso, relative = false, seconds = false, className, empty = "—", options }: {
  iso: string | Date | null | undefined;
  /** Mostra também o "há X min" ao lado. */
  relative?: boolean;
  seconds?: boolean;
  className?: string;
  empty?: string;
  options?: Omit<DateTimeOptions, "seconds">;
}) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  if (iso === null || iso === undefined || iso === "") return <span className={className}>{empty}</span>;
  const p = presentDateTime(iso, { ...options, seconds });
  if (!p) return <span className={className}>{empty}</span>;
  if (!mounted) return <time dateTime={p.iso} className={className} suppressHydrationWarning>{p.iso.slice(0, 16).replace("T", " ")} UTC</time>;
  return (
    <time dateTime={p.iso} title={p.tooltip} className={className}>
      {p.absolute}
      {relative && <span className="text-base-content/70"> · {p.relative}</span>}
    </time>
  );
}
