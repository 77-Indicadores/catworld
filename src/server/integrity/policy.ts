/**
 * Política de integridade de uma carga (upload, refresh de fonte ou tabela derivada).
 *
 * Princípio (docs/estudo-confiabilidade-dados.md, seções 6-7): o Catworld nunca publica uma tabela que ele mesmo sabe estar
 * incompleta. A decisão compara o que foi CARREGADO com o que era ESPERADO (contagem do arquivo/da origem, independente do
 * próprio carregamento) e com a versão anterior — nunca só o carregamento consigo mesmo.
 *
 * Funções puras + um leitor de configuração. Quem chama decide o que fazer com o veredito: FAILED = não trocar a tabela
 * (a anterior continua no ar, completa); SUSPECT = publicar e marcar como "possivelmente incompleta".
 */
import { prisma } from "@/server/db";
import { pickInt } from "@/server/worker/config";

export type Verdict = "OK" | "SUSPECT" | "FAILED";

export type ReasonCode =
  | "ROWS_BELOW_EXPECTED"     // carregou menos linhas do que o arquivo/origem tem
  | "ROWS_ABOVE_EXPECTED"     // carregou mais (os leitores discordam) — publica, mas avisa
  | "EMPTY_REPLACE"           // substituição completa por 0 linhas sobre tabela que tinha dados
  | "DROP_GT_PCT"             // queda grande de linhas contra a versão anterior
  | "STAGED_MISMATCH"         // staging tem número diferente do que foi lido
  | "RETRY_WITHOUT_EXPECTED"; // retentativa que reaproveitou carga anterior sem contagem esperada para conferir

export type Reason = { code: ReasonCode; blocking: boolean; message: string };

export type LoadFacts = {
  kind: "upload" | "source" | "derived";
  /** o arquivo/consulta substitui a tabela inteira (replace, fullSnapshot, refresh sem chave) */
  fullState: boolean;
  /** staging tem só uma diferença (phase2 do SDK): contagens do arquivo não se aplicam */
  deltaOnly?: boolean;
  /** contagem esperada obtida de forma independente da carga; 0/undefined = desconhecida */
  expectedRows?: number;
  parsedRows: number;
  stagedRows?: number;
  /** linhas da versão anterior (0 = tabela nova) */
  prevRows?: number;
  wasRetryReusingStaging?: boolean;
  /** carga agendada (fonte): queda grande bloqueia; upload manual só marca */
  scheduled?: boolean;
};

export type IntegritySettings = { mode: "enforce" | "warn"; maxDropPct: number; allowEmpty: boolean };
export const INTEGRITY_DEFAULTS: IntegritySettings = { mode: "enforce", maxDropPct: 30, allowEmpty: false };

export type Evaluation = { verdict: Verdict; reasons: Reason[] };

/** Menor tabela anterior para a qual a queda percentual é avaliada (evita alarme em tabelas minúsculas). */
export const MIN_ROWS_FOR_DROP_CHECK = 50;

export function evaluateLoad(f: LoadFacts, cfg: IntegritySettings = INTEGRITY_DEFAULTS): Evaluation {
  const reasons: Reason[] = [];
  const prev = f.prevRows ?? 0;
  const expected = f.expectedRows && f.expectedRows > 0 ? f.expectedRows : 0;

  if (!f.deltaOnly && expected > 0) {
    if (f.parsedRows < expected) {
      reasons.push({ code: "ROWS_BELOW_EXPECTED", blocking: true, message: `Foram lidas ${f.parsedRows} linhas, mas a origem tem ${expected}.` });
    } else if (f.parsedRows > expected) {
      reasons.push({ code: "ROWS_ABOVE_EXPECTED", blocking: false, message: `Foram lidas ${f.parsedRows} linhas, mais que as ${expected} esperadas (leitores discordam).` });
    }
  }
  if (f.wasRetryReusingStaging && expected === 0 && !f.deltaOnly) {
    reasons.push({ code: "RETRY_WITHOUT_EXPECTED", blocking: false, message: "Retentativa reaproveitou carga anterior sem contagem esperada para conferir." });
  }
  if (f.stagedRows !== undefined && f.stagedRows !== f.parsedRows && !f.wasRetryReusingStaging) {
    reasons.push({ code: "STAGED_MISMATCH", blocking: true, message: `A staging tem ${f.stagedRows} linhas, mas foram lidas ${f.parsedRows}.` });
  }
  if (f.fullState && !f.deltaOnly && f.parsedRows === 0 && prev > 0 && !cfg.allowEmpty) {
    reasons.push({ code: "EMPTY_REPLACE", blocking: true, message: `Substituição completa por 0 linhas sobre uma tabela com ${prev}.` });
  } else if (f.fullState && !f.deltaOnly && prev >= MIN_ROWS_FOR_DROP_CHECK && f.parsedRows < prev * (1 - cfg.maxDropPct / 100) && f.parsedRows > 0) {
    reasons.push({
      code: "DROP_GT_PCT",
      blocking: !!f.scheduled,
      message: `Queda de ${prev} para ${f.parsedRows} linhas (mais de ${cfg.maxDropPct}%).`,
    });
  }

  if (reasons.length === 0) return { verdict: "OK", reasons };
  const blocking = reasons.some((r) => r.blocking);
  return { verdict: blocking && cfg.mode === "enforce" ? "FAILED" : "SUSPECT", reasons };
}

/** Mensagem de erro (com código estável) para uma carga barrada. */
export function integrityErrorMessage(e: Evaluation): string {
  return `[integrity] ${e.reasons.filter((r) => r.blocking).map((r) => `${r.code}: ${r.message}`).join(" ")} A tabela anterior foi mantida.`;
}

export class IntegrityError extends Error {
  constructor(public evaluation: Evaluation) {
    super(integrityErrorMessage(evaluation));
    this.name = "IntegrityError";
  }
}

export const SETTING_KEYS = { mode: "integrity.mode", maxDropPct: "integrity.max_drop_pct", allowEmpty: "integrity.allow_empty" } as const;

/** Lê a configuração; valor ausente, inválido ou fora da faixa cai no padrão (nunca desliga a proteção por engano). */
export async function getIntegritySettings(): Promise<IntegritySettings> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ key: string; value: string }[]>(
      `SELECT key, value FROM cw_system_settings WHERE key = ANY($1::text[])`,
      Object.values(SETTING_KEYS),
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      mode: by[SETTING_KEYS.mode] === "warn" ? "warn" : "enforce",
      maxDropPct: pickInt(by[SETTING_KEYS.maxDropPct], INTEGRITY_DEFAULTS.maxDropPct, 1, 99),
      allowEmpty: by[SETTING_KEYS.allowEmpty] === "true",
    };
  } catch {
    return INTEGRITY_DEFAULTS; // sem banco de metadados a proteção continua ligada
  }
}
