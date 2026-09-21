/**
 * Datas do arquivo → forma ISO (TIP-11, docs/estudo-confiabilidade-dados.md).
 *
 * Regras (as mesmas nos caminhos Postgres e SQL Server):
 *  - dd/mm × mm/dd é decidido por COLUNA (ver `slashCandidates` e o stats do parser), nunca por valor. `normalizeDateLike` sem `order`
 *    mantém o critério legado por valor apenas para mapeamentos gerados antes desta regra.
 *  - Offset de fuso: `Z`, `+00:00` e `-00:00` significam UTC e são descartados (o horário guardado é o UTC, sem fuso). Qualquer OUTRO offset
 *    (`-03:00`) não é representável em DATE/DATETIME2 sem trocar a hora: o valor NÃO é data (a coluna fica TEXT) e, se chegar à conversão
 *    por um override de tipo, é erro — nunca é descartado nem convertido em silêncio.
 */
export type DateOrder = "dmy" | "mdy";

const TIME_PART = "(?:[T ](\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?)(Z|[+-]\\d{2}:?\\d{2})?)?";
const RE_ISO_DATE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${TIME_PART}$`);
const RE_SLASH_DATE = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})${TIME_PART}$`);

function validParts(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(hhmmss: string): boolean {
  const [h, m, s = "0"] = hhmmss.split(":");
  const sec = s.split(".")[0]!;
  return Number(h) <= 23 && Number(m) <= 59 && Number(sec) <= 59;
}

/** null = fuso não representável / hora inválida; string = sufixo de hora normalizado ("" sem hora). */
function timeSuffix(sep: string | undefined, time: string | undefined, offset: string | undefined, whole: string): string | null {
  if (time === undefined) return "";
  if (!validTime(time)) return null;
  if (offset !== undefined && !/^(Z|[+-]00:?00)$/.test(offset)) return null;
  const isoSep = whole.includes("T") ? "T" : " ";
  return `${isoSep}${time}`;
}

function build(year: number, month: number, day: number, suffix: string | null): string | null {
  if (suffix === null || !validParts(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${suffix}`;
}

/** Candidatos de um valor com barras: um por ordem possível (null quando essa ordem não produz data válida). ISO devolve o mesmo nas duas. */
export function dateCandidates(value: string): { dmy: string | null; mdy: string | null } {
  const s = value.trim();
  const iso = s.match(RE_ISO_DATE);
  if (iso) {
    const r = build(Number(iso[1]), Number(iso[2]), Number(iso[3]), timeSuffix(undefined, iso[4], iso[5], s));
    return { dmy: r, mdy: r };
  }
  const sl = s.match(RE_SLASH_DATE);
  if (!sl) return { dmy: null, mdy: null };
  const a = Number(sl[1]), b = Number(sl[2]), y = Number(sl[3]);
  const suffix = timeSuffix(undefined, sl[4], sl[5], s);
  return { dmy: build(y, b, a, suffix), mdy: build(y, a, b, suffix) };
}

/** O valor tem barras e as duas ordens são válidas e dão datas DIFERENTES (ex.: 04/05/2026)? Só a coluna inteira pode resolver. */
export function isOrderAmbiguous(c: { dmy: string | null; mdy: string | null }): boolean {
  return c.dmy !== null && c.mdy !== null && c.dmy !== c.mdy;
}

export function normalizeDateLike(value: string, order?: DateOrder | null): string | null {
  const c = dateCandidates(value);
  if (order === "dmy") return c.dmy;
  if (order === "mdy") return c.mdy;
  // legado (mapeamento sem convenção de coluna): dd/mm, exceto quando só mm/dd é possível
  if (c.dmy !== null && c.mdy !== null) return c.dmy;
  return c.dmy ?? c.mdy;
}

export function isDateLike(value: string) {
  return normalizeDateLike(value) != null;
}

export function hasDateTimePart(value: string) {
  const normalized = normalizeDateLike(value);
  return normalized != null && /[T ]\d{2}:\d{2}(:\d{2})?/.test(normalized);
}
