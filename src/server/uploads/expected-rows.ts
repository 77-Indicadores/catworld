/**
 * Contagem ESPERADA do gate de integridade (upload): so vale o que o SERVIDOR contou.
 *
 * O navegador manda `rowCount` e o preview no POST /uploads e o servidor pula o preview dele (action=uploaded). Confiar nesse numero como
 * prova deixava o gate calibrado por um valor de fora (errado, velho ou de outro parser). Ordem de confianca:
 *  1. preview feito pelo worker (`previewJson.source === "server"`);
 *  2. contagem independente feita agora pelo servidor sobre o arquivo (mesma regra do preview, sem inferir tipos);
 *  3. indisponivel: nao ha prova; o gate marca SUSPECT (nao usa o numero do cliente).
 * Se o numero do cliente diverge do servidor, o do servidor prevalece e a divergencia fica registrada.
 */
import { countDataRows } from "./parser";

export type ExpectedRows = {
  /** 0 = desconhecida (o gate nao usa) */
  expected: number;
  source: "server-preview" | "server-count" | "unavailable";
  clientRowCount: number | null;
  /** divergencia entre o valor do cliente e o do servidor */
  clientDisagrees: boolean;
};

/** previewJson vindo do cliente: remove a marca `source` (so o worker a escreve). JSON invalido volta como veio (o resto do fluxo ja o trata). */
export function stripServerMark(previewJson: string): string {
  try {
    const p = JSON.parse(previewJson);
    if (p && typeof p === "object" && !Array.isArray(p) && "source" in p) { delete p.source; return JSON.stringify(p); }
  } catch { /* invalido: segue */ }
  return previewJson;
}

export async function resolveExpectedRows(
  upload: { rowCount: bigint | number | null; previewJson: string | null },
  source: string | NodeJS.ReadableStream,
  count: (path: string) => Promise<number | null> = countDataRows,
): Promise<ExpectedRows> {
  const clientRowCount = upload.rowCount == null ? null : Number(upload.rowCount);
  let preview: { rowCount?: number; source?: string } | null = null;
  try { preview = upload.previewJson ? JSON.parse(upload.previewJson) : null; } catch { preview = null; }

  let expected = 0;
  let src: ExpectedRows["source"] = "unavailable";
  if (preview?.source === "server" && Number.isFinite(preview.rowCount)) {
    expected = Number(preview.rowCount);
    src = "server-preview";
  } else if (typeof source === "string") {
    const n = await count(source).catch(() => null);
    if (n !== null && Number.isFinite(n)) { expected = n; src = "server-count"; }
  }
  const clientDisagrees = src !== "unavailable" && clientRowCount !== null && clientRowCount > 0 && clientRowCount !== expected;
  return { expected, source: src, clientRowCount, clientDisagrees };
}
