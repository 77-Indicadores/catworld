import { beforeEach, describe, expect, it, vi } from "vitest";

// A 1a importacao do parser (node-sql-parser) e lenta sob carga; cada teste recarrega o modulo
vi.setConfig({ testTimeout: 30_000 });

const state = { mode: undefined as string | undefined };
vi.mock("@/server/db", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => (state.mode ? [{ value: state.mode }] : [])) },
}));

// O modo fica em cache de 30s no modulo; cada teste usa uma copia nova do modulo
async function fresh() {
  vi.resetModules();
  return import("./apply");
}

const warnings = () =>
  (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => JSON.parse(c[0]!));

class PgError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

beforeEach(() => {
  state.mode = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("contractTranslate por modo", () => {
  it("mssql nunca e tocado", async () => {
    const { contractTranslate } = await fresh();
    expect((await contractTranslate("SELECT TOP 5 * FROM t", "mssql", "x", "regex")).sql).toBe("SELECT TOP 5 * FROM t");
  });

  it("shadow: responde como antes (live = passthrough) e loga o que o motor novo rejeitaria", async () => {
    state.mode = "shadow";
    const { contractTranslate } = await fresh();
    const r = await contractTranslate("SELECT a::text FROM t", "postgres", "live-pg", "passthrough");
    expect(r.sql).toBe("SELECT a::text FROM t");
    expect(warnings()[0]).toMatchObject({ tag: "sql-contract", kind: "shadow-reject", path: "live-pg" });
  });

  it("shadow no storage PG: resposta e a do regex antigo", async () => {
    state.mode = "shadow";
    const { contractTranslate } = await fresh();
    const r = await contractTranslate("SELECT TOP 3 ISNULL(a,0) FROM t", "postgres", "storage-pg", "regex");
    expect(r.topLimit).toBe(3);
    expect(r.sql).toContain("COALESCE(");
  });

  it("log nao carrega literais", async () => {
    state.mode = "shadow";
    const { contractTranslate } = await fresh();
    await contractTranslate("SELECT a::text FROM t WHERE c = 'segredo-123'", "postgres", "live-pg", "passthrough");
    expect(console.warn as unknown as { mock: { calls: string[][] } }).toBeTruthy();
    expect((console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).not.toContain("segredo-123");
  });

  it("strict rejeita '::' e construcoes fora do contrato", async () => {
    state.mode = "strict";
    const { contractTranslate } = await fresh();
    await expect(contractTranslate("SELECT a::text FROM t", "postgres", "live-pg", "passthrough")).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRUCT" });
    await expect(contractTranslate("SELECT * FROM t WHERE a ILIKE 'x'", "postgres", "live-pg", "passthrough")).rejects.toMatchObject({ code: "UNSUPPORTED_CONSTRUCT" });
  });

  it("off: comportamento antigo, sem log", async () => {
    state.mode = "off";
    const { contractTranslate } = await fresh();
    const r = await contractTranslate("SELECT a::text FROM t", "postgres", "live-pg", "passthrough");
    expect(r.sql).toBe("SELECT a::text FROM t");
    expect(warnings().length).toBe(0);
  });

  it("padrao (sem configuracao) e fallback: motor novo, e o antigo quando o novo rejeita", async () => {
    const { contractTranslate, getContractMode } = await fresh();
    expect(await getContractMode()).toBe("fallback");
    const novo = await contractTranslate("SELECT TOP 2 IIF(a>1,'x','y') AS f FROM t", "postgres", "storage-pg", "regex");
    expect(novo.sql).toContain("CASE WHEN"); // IIF: so o motor novo sabe traduzir
    const pgNativo = await contractTranslate("SELECT a::text FROM t", "postgres", "live-pg", "passthrough");
    expect(pgNativo.sql).toBe("SELECT a::text FROM t"); // rejeitado -> caminho antigo
    expect(warnings().at(-1)).toMatchObject({ kind: "fallback-reject", path: "live-pg" });
  });
});

describe("runWithContract (modo fallback)", () => {
  it("motor novo funciona: executa uma vez com o SQL novo", async () => {
    const { runWithContract } = await fresh();
    const exec = vi.fn(async (t: { sql: string }) => `ok:${t.sql}`);
    const r = await runWithContract("SELECT IIF(a>1,'x','y') AS f FROM t", "postgres", "storage-pg", "regex", exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r).toContain("CASE WHEN");
  });

  it("motor novo rejeita: usa o antigo direto, sem tentar o novo", async () => {
    const { runWithContract } = await fresh();
    const exec = vi.fn(async (t: { sql: string }) => t.sql);
    const r = await runWithContract("SELECT a::text FROM t", "postgres", "live-pg", "passthrough", exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r).toBe("SELECT a::text FROM t");
  });

  it("SQL novo falha no banco: refaz com o antigo e devolve o resultado do antigo", async () => {
    const { runWithContract } = await fresh();
    const exec = vi.fn(async (t: { sql: string }) => {
      if (t.sql.includes("CASE WHEN")) throw new PgError("erro qualquer do SQL novo", "42883");
      return "resultado-antigo";
    });
    const r = await runWithContract("SELECT IIF(a>1,'x','y') AS f FROM t", "postgres", "storage-pg", "passthrough", exec);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(r).toBe("resultado-antigo");
    expect(warnings().at(-1)).toMatchObject({ kind: "fallback-exec" });
  });

  it("os dois falham: propaga o erro do ANTIGO (comportamento anterior)", async () => {
    const { runWithContract } = await fresh();
    let n = 0;
    const exec = vi.fn(async () => { throw new PgError(n++ === 0 ? "erro do novo" : "erro do antigo", "42883"); });
    await expect(runWithContract("SELECT IIF(a>1,1,0) FROM t", "postgres", "live-pg", "passthrough", exec)).rejects.toThrow("erro do antigo");
  });

  it("timeout do banco (57014) e erro da aplicacao NAO repetem", async () => {
    const { runWithContract } = await fresh();
    const timeout = vi.fn(async () => { throw new PgError("statement timeout", "57014"); });
    await expect(runWithContract("SELECT IIF(a>1,1,0) FROM t", "postgres", "live-pg", "passthrough", timeout)).rejects.toThrow("statement timeout");
    expect(timeout).toHaveBeenCalledTimes(1);

    const app = vi.fn(async () => { throw Object.assign(new Error("Resultado grande"), { code: "RESULT_TOO_LARGE" }); });
    await expect(runWithContract("SELECT IIF(a>1,1,0) FROM t", "postgres", "live-pg", "passthrough", app)).rejects.toThrow("Resultado grande");
    expect(app).toHaveBeenCalledTimes(1);
  });

  it("erro do banco quando novo e antigo geram o mesmo SQL: nao repete", async () => {
    const { runWithContract } = await fresh();
    const exec = vi.fn(async () => { throw new PgError("coluna inexistente", "42703"); });
    await expect(runWithContract("SELECT nome FROM t", "postgres", "storage-pg", "passthrough", exec)).rejects.toThrow("coluna inexistente");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("modos fora do fallback executam uma vez so, sem retentativa", async () => {
    state.mode = "strict";
    const { runWithContract } = await fresh();
    const exec = vi.fn(async () => { throw new PgError("falha", "42883"); });
    await expect(runWithContract("SELECT IIF(a>1,1,0) FROM t", "postgres", "live-pg", "passthrough", exec)).rejects.toThrow("falha");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("contadores (getContractStats)", () => {
  // O estado e um singleton do processo (globalThis): zera antes de cada teste
  beforeEach(async () => { (await fresh()).resetContractStats(); });

  it("conta traducoes por caminho e agrupa o mesmo formato de consulta", async () => {
    const { contractTranslate, getContractStats } = await fresh();
    await contractTranslate("SELECT a::text FROM t WHERE c = 'um'", "postgres", "live-pg", "passthrough");
    await contractTranslate("SELECT a::text FROM t WHERE c = 'outro valor'", "postgres", "live-pg", "passthrough"); // mesmo formato
    await contractTranslate("SELECT 1 FROM t", "postgres", "storage-pg", "regex");
    const st = getContractStats();
    expect(st.translated).toEqual({ "live-pg": 2, "storage-pg": 1 });
    expect(st.byKind["fallback-reject"]).toBe(2);
    expect(st.top).toHaveLength(1);
    expect(st.top[0]).toMatchObject({ kind: "fallback-reject", path: "live-pg", count: 2 });
  });

  it("nao guarda valores: literais viram '?'", async () => {
    const { contractTranslate, getContractStats } = await fresh();
    await contractTranslate("SELECT a::text FROM t WHERE cpf = '123.456.789-00'", "postgres", "live-pg", "passthrough");
    expect(JSON.stringify(getContractStats())).not.toContain("123.456");
    expect(getContractStats().top[0]!.shape).toContain("'?'");
  });

  it("conta a execucao que caiu no caminho antigo (fallback-exec) e o reset zera tudo", async () => {
    const { runWithContract, getContractStats, resetContractStats } = await fresh();
    await runWithContract("SELECT IIF(a>1,1,0) FROM t", "postgres", "storage-pg", "passthrough", async (t: { sql: string }) => {
      if (t.sql.includes("CASE WHEN")) throw new PgError("falha do SQL novo", "42883");
      return "ok";
    });
    expect(getContractStats().byKind["fallback-exec"]).toBe(1);
    resetContractStats();
    expect(getContractStats().top).toEqual([]);
    expect(getContractStats().translated).toEqual({});
  });

  it("mssql nao entra na contagem", async () => {
    const { contractTranslate, getContractStats } = await fresh();
    await contractTranslate("SELECT 1", "mssql", "x", "regex");
    expect(getContractStats().translated).toEqual({});
  });
});
