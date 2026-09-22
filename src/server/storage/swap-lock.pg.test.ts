// @vitest-environment node
/**
 * A troca atômica (DROP+RENAME) não pode deixar um leitor longo parar TODOS os leitores (PER-04). Contra Postgres real.
 * Só roda com CW_TEST_PG_URL (banco DESCARTÁVEL; NUNCA produção). Schema único por execução.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgStorageConnection } from "./pg-storage";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const S = `sw_${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("atomicSwap com leitor longo (Postgres real)", () => {
  const admin = new Pool({ connectionString: url, max: 6 });
  const conn = new PgStorageConnection("swap-lock-test", url!);
  const cols = [{ name: "id", sqlType: "BIGINT", nullable: true }, { name: "v", sqlType: "NVARCHAR(MAX)", nullable: true }];
  const saved = { ...PgStorageConnection.swapTuning };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${S}`);
    await admin.query(`CREATE TABLE ${S}.alvo (id bigint, v text, cw_synced_at timestamp NOT NULL DEFAULT now(), cw_deleted_at timestamp NULL)`);
    await admin.query(`INSERT INTO ${S}.alvo (id, v) SELECT g, 'antigo' FROM generate_series(1, 1000) g`);
    PgStorageConnection.swapTuning = { lockTimeoutMs: 300, attempts: 40, backoffMs: 100 };
  });
  afterAll(async () => {
    PgStorageConnection.swapTuning = saved;
    await admin.query(`DROP SCHEMA ${S} CASCADE`);
    await admin.end();
  });

  it("um leitor longo não trava os leitores novos e a troca conclui assim que ele solta", async () => {
    // leitor longo: transação aberta segurando a tabela por ~1,8 s
    const longReader = await admin.connect();
    await longReader.query("BEGIN");
    await longReader.query(`SELECT count(*) FROM ${S}.alvo`);
    const releaseAt = Date.now() + 1800;
    const releaser = (async () => { await sleep(1800); await longReader.query("COMMIT"); longReader.release(); })();

    // staging com o conteúdo novo
    await admin.query(`CREATE TABLE ${S}.stg (id bigint, v text)`);
    await admin.query(`INSERT INTO ${S}.stg (id, v) SELECT g, 'novo' FROM generate_series(1, 2000) g`);

    const t0 = Date.now();
    const swap = conn.atomicSwap(S, "stg", "alvo", cols as never, { targetExists: true });

    // durante a espera da troca, leitores NOVOS precisam responder depressa (antes: paravam atrás do DROP até o leitor longo soltar)
    await sleep(500);
    const latencies: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = Date.now();
      await admin.query(`SELECT 1 FROM ${S}.alvo LIMIT 1`);
      latencies.push(Date.now() - t);
      await sleep(150);
    }
    await swap; await releaser;

    expect(Math.max(...latencies)).toBeLessThan(700);           // sem a correção: ~1,3 s (o resto do leitor longo)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);      // a troca esperou o leitor longo soltar
    expect(Date.now()).toBeGreaterThanOrEqual(releaseAt - 50);
    const r = (await admin.query(`SELECT count(*)::int n, min(v) v FROM ${S}.alvo`)).rows[0];
    expect(r).toEqual({ n: 2000, v: "novo" });                  // trocou por inteiro
  }, 30_000);

  it("desiste com erro claro se o leitor nunca solta (sem ficar preso para sempre)", async () => {
    PgStorageConnection.swapTuning = { lockTimeoutMs: 100, attempts: 3, backoffMs: 50 };
    const blocker = await admin.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT count(*) FROM ${S}.alvo`);
    await admin.query(`CREATE TABLE ${S}.stg2 (id bigint, v text)`);
    await admin.query(`INSERT INTO ${S}.stg2 VALUES (1, 'x')`);
    try {
      await expect(conn.atomicSwap(S, "stg2", "alvo", cols as never, { targetExists: true })).rejects.toThrow(/Não consegui trocar a tabela/);
      const n = (await admin.query(`SELECT count(*)::int n FROM ${S}.alvo`)).rows[0].n;
      expect(n).toBe(2000);                                     // a tabela antiga continua íntegra
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      PgStorageConnection.swapTuning = { lockTimeoutMs: 300, attempts: 40, backoffMs: 100 };
    }
  }, 30_000);
});
