import { describe, expect, it } from "vitest";
import { INTEGRITY_DEFAULTS, IntegrityError, evaluateLoad, integrityErrorMessage } from "./policy";

const base = { kind: "upload" as const, fullState: true, expectedRows: 828_672, parsedRows: 828_672, prevRows: 828_672 };

describe("evaluateLoad", () => {
  it("carga completa e igual à anterior: OK", () => {
    expect(evaluateLoad(base)).toEqual({ verdict: "OK", reasons: [] });
  });

  it("o incidente da ADL: 50.000 de 828.672 numa retentativa → FAILED (a tabela anterior fica)", () => {
    const e = evaluateLoad({ ...base, parsedRows: 50_000, stagedRows: 50_000, wasRetryReusingStaging: true });
    expect(e.verdict).toBe("FAILED");
    expect(e.reasons.map((r) => r.code)).toContain("ROWS_BELOW_EXPECTED");
    expect(e.reasons.map((r) => r.code)).toContain("DROP_GT_PCT");
  });

  it("um único registro faltando já barra (tolerância zero)", () => {
    expect(evaluateLoad({ ...base, parsedRows: 828_671 }).verdict).toBe("FAILED");
  });

  it("mais linhas que o esperado: publica, mas marca SUSPECT (os leitores discordam)", () => {
    const e = evaluateLoad({ ...base, parsedRows: 828_673 });
    expect(e.verdict).toBe("SUSPECT");
    expect(e.reasons[0]!.code).toBe("ROWS_ABOVE_EXPECTED");
  });

  it("substituir uma tabela com dados por 0 linhas: FAILED, a menos que allowEmpty", () => {
    const facts = { ...base, expectedRows: 0, parsedRows: 0 };
    expect(evaluateLoad(facts).reasons.map((r) => r.code)).toEqual(["EMPTY_REPLACE"]);
    expect(evaluateLoad(facts).verdict).toBe("FAILED");
    expect(evaluateLoad(facts, { ...INTEGRITY_DEFAULTS, allowEmpty: true }).verdict).toBe("OK");
  });

  it("tabela nova carregada com 0 linhas não é 'esvaziar' nada", () => {
    expect(evaluateLoad({ ...base, expectedRows: 0, parsedRows: 0, prevRows: 0 }).verdict).toBe("OK");
  });

  it("queda grande sem contagem esperada: fonte agendada bloqueia, upload manual só marca", () => {
    const facts = { ...base, expectedRows: 0, parsedRows: 400_000 };
    expect(evaluateLoad({ ...facts, scheduled: true }).verdict).toBe("FAILED");
    expect(evaluateLoad({ ...facts, scheduled: false }).verdict).toBe("SUSPECT");
    expect(evaluateLoad({ ...facts, scheduled: false }).reasons[0]!.code).toBe("DROP_GT_PCT");
  });

  it("queda dentro do limite ou em tabela minúscula: OK", () => {
    expect(evaluateLoad({ ...base, expectedRows: 0, parsedRows: 700_000 }).verdict).toBe("OK"); // -15%
    expect(evaluateLoad({ ...base, expectedRows: 0, parsedRows: 3, prevRows: 40 }).verdict).toBe("OK"); // < 50 linhas antes
  });

  it("staging diferente do que foi lido: FAILED", () => {
    const e = evaluateLoad({ ...base, stagedRows: 828_000 });
    expect(e.verdict).toBe("FAILED");
    expect(e.reasons[0]!.code).toBe("STAGED_MISMATCH");
  });

  it("retentativa que reaproveitou staging: a contagem da staging não é evidência de nada", () => {
    // staged == parsed por construção; o que vale é o esperado
    expect(evaluateLoad({ ...base, stagedRows: 828_672, wasRetryReusingStaging: true }).verdict).toBe("OK");
    const noExpected = evaluateLoad({ ...base, expectedRows: 0, wasRetryReusingStaging: true });
    expect(noExpected.verdict).toBe("SUSPECT");
    expect(noExpected.reasons[0]!.code).toBe("RETRY_WITHOUT_EXPECTED");
  });

  it("phase2 (só a diferença): as contagens do arquivo e a queda não se aplicam", () => {
    expect(evaluateLoad({ ...base, deltaOnly: true, parsedRows: 10, expectedRows: 10 }).verdict).toBe("OK");
    expect(evaluateLoad({ ...base, deltaOnly: true, parsedRows: 0 }).verdict).toBe("OK");
  });

  it("append/upsert (não é estado completo): sem regra de queda nem de vazio, mas ainda confere o esperado", () => {
    const append = { ...base, fullState: false, parsedRows: 10, expectedRows: 500 };
    expect(evaluateLoad({ ...append, expectedRows: 10 }).verdict).toBe("OK");
    expect(evaluateLoad(append).verdict).toBe("FAILED");
  });

  it("modo warn: o que bloquearia vira SUSPECT (publica e marca)", () => {
    const e = evaluateLoad({ ...base, parsedRows: 50_000 }, { ...INTEGRITY_DEFAULTS, mode: "warn" });
    expect(e.verdict).toBe("SUSPECT");
    expect(e.reasons.some((r) => r.blocking)).toBe(true);
  });
});

describe("integrityErrorMessage / IntegrityError", () => {
  it("mensagem com prefixo estável, motivo e a garantia de que a tabela anterior ficou", () => {
    const ev = evaluateLoad({ ...base, parsedRows: 50_000 });
    const msg = integrityErrorMessage(ev);
    expect(msg.startsWith("[integrity] ROWS_BELOW_EXPECTED")).toBe(true);
    expect(msg).toContain("A tabela anterior foi mantida");
    const err = new IntegrityError(ev);
    expect(err.message).toBe(msg);
    expect(err.evaluation.verdict).toBe("FAILED");
  });
});
