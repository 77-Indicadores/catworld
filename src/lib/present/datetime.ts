/**
 * Apresentação de data e hora — ÚNICO lugar que formata instantes para a tela.
 * O servidor só envia ISO; a formatação acontece no cliente, no fuso do navegador, com o UTC no tooltip.
 * Funções puras: `now` e `timeZone` podem ser injetados (testes).
 */

export type DateTimePresentation = {
  /** `19/09/2026 14:32` (ou `14:32:05` com `seconds`), no fuso `timeZone`. */
  absolute: string;
  /** `19/09/2026`. */
  date: string;
  /** `14:32`. */
  time: string;
  /** `há 12 min`, `agora`, `em 5 min` (futuro). */
  relative: string;
  /** `19/09/2026 17:32:05 UTC · America/Sao_Paulo (14:32)` — para `title`. */
  tooltip: string;
  /** ISO original normalizado (para `<time dateTime>`). */
  iso: string;
  timeZone: string;
};

export type DateTimeOptions = { now?: Date; timeZone?: string; seconds?: boolean };

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parts(d: Date, timeZone: string, seconds: boolean) {
  const f = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
  const m = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${m.day}/${m.month}/${m.year}`,
    time: seconds ? `${m.hour}:${m.minute}:${m.second}` : `${m.hour}:${m.minute}`,
  };
}

/** Tempo relativo em PT-BR; passado ("há 5 min") e futuro ("em 5 min"). */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const future = diff < 0;
  const mins = Math.floor(Math.abs(diff) / 60000);
  if (mins < 1) return "agora";
  const span = mins < 60 ? `${mins} min` : mins < 60 * 24 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
  return future ? `em ${span}` : `há ${span}`;
}

/** Aceita ISO/Date/epoch; `null`/inválido = `null` (a tela mostra "—", nunca "Invalid Date"). */
export function presentDateTime(input: string | Date | number | null | undefined, options: DateTimeOptions = {}): DateTimePresentation | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const timeZone = options.timeZone ?? browserTimeZone();
  const seconds = options.seconds ?? false;
  const local = parts(d, timeZone, seconds);
  const utc = parts(d, "UTC", true);
  return {
    absolute: `${local.date} ${local.time}`,
    date: local.date,
    time: local.time,
    relative: relativeTime(d, options.now ?? new Date()),
    tooltip: `${utc.date} ${utc.time} UTC · ${timeZone} (${local.time})`,
    iso: d.toISOString(),
    timeZone,
  };
}

/** Data por extenso ("19 de setembro de 2026"), para títulos; usa o fuso do ambiente onde renderiza. */
export function presentLongDate(input: Date = new Date(), timeZone?: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", ...(timeZone ? { timeZone } : {}) }).format(input);
}

/** Horário de um cron: sempre UTC, dito explicitamente (o cron do sistema roda em UTC). */
export function presentUtc(input: string | Date | null | undefined): string | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const p = parts(d, "UTC", false);
  return `${p.date} ${p.time} UTC`;
}
