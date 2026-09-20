/**
 * SQL do claim (faixas por peso, teto de pesados, limite por storage, ordem, concorrência) contra Postgres REAL.
 * Só roda com CW_TEST_PG_URL (Postgres descartável — NUNCA produção).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildClaimSql } from "./claim";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const SCHEMA = "claim_test";

d("claim (Postgres real)", () => {
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on("connect", (c) => { void c.query(`SET search_path TO ${SCHEMA}`); });

  const claim = async (types: string[] | null, weights: number[], opts: { heavy?: number; perStorage?: number; by?: string } = {}) => {
    const r = await pool.query(buildClaimSql(types), [opts.by ?? "w-1", opts.heavy ?? 99, opts.perStorage ?? 99, weights]);
    return r.rows[0] as { id: string; type: string; weight: number } | undefined;
  };
  const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let seq = 0;
  const add = (o: { type?: string; weight?: number; status?: string; storage?: string | null; availableIn?: string; lockedBy?: string }) =>
    pool.query(
      `INSERT INTO ${SCHEMA}.cw_jobs (id, type, status, weight, available_at, storage_server_id, locked_by, attempts, max_attempts)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + $4::interval, $5, $6, 0, 3)`,
      [o.type ?? "SOURCE_REFRESH", o.status ?? "QUEUED", o.weight ?? 0, o.availableIn ?? `-${1000 - seq++} seconds`, o.storage ?? null, o.lockedBy ?? null],
    );

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}.cw_jobs (
      id uuid PRIMARY KEY, type text, status text, upload_id uuid, payload_json text, attempts int, max_attempts int, weight smallint,
      available_at timestamp, locked_at timestamp, locked_by text, heartbeat_at timestamp, storage_server_id uuid)`);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end(); });
  beforeEach(async () => { seq = 0; await pool.query(`TRUNCATE ${SCHEMA}.cw_jobs`); });

  it("faixa vazia = qualquer peso (comportamento anterior): leves primeiro, depois os pesados", async () => {
    await add({ weight: 2 }); await add({ weight: 0 }); await add({ weight: 1 });
    expect([(await claim(null, []))!.weight, (await claim(null, []))!.weight, (await claim(null, []))!.weight]).toEqual([0, 1, 2]);
    expect(await claim(null, [])).toBeUndefined();
  });

  it("faixa leve [0,1] NUNCA pega peso 2, mesmo sozinho na fila (ele espera a faixa pesada)", async () => {
    await add({ weight: 2 });
    expect(await claim(null, [0, 1])).toBeUndefined();
    await add({ weight: 1 });
    expect((await claim(null, [0, 1]))!.weight).toBe(1);
    expect(await claim(null, [0, 1])).toBeUndefined();
  });

  it("faixa pesada [2] só pega peso 2", async () => {
    await add({ weight: 0 }); await add({ weight: 1 });
    expect(await claim(null, [2])).toBeUndefined();
    await add({ weight: 2 });
    expect((await claim(null, [2]))!.weight).toBe(2);
  });

  it("filtro de tipo: o perfil só pega os tipos dele", async () => {
    await add({ type: "IMPORT_UPLOAD", weight: 1 }); await add({ type: "SOURCE_REFRESH", weight: 0 });
    expect((await claim(["SOURCE_REFRESH"], []))!.type).toBe("SOURCE_REFRESH");
    expect(await claim(["SOURCE_REFRESH"], [])).toBeUndefined();
    expect((await claim(["IMPORT_UPLOAD", "PREVIEW_UPLOAD"], []))!.type).toBe("IMPORT_UPLOAD");
  });

  it("uma job longa em execução (faixa longa) NÃO bloqueia a faixa rápida: o gargalo que motivou as faixas", async () => {
    await add({ weight: 2, status: "RUNNING", lockedBy: "worker-sync-long-1@h" }); // ex.: incremental de 5 min
    for (let i = 0; i < 5; i++) await add({ weight: 0 });                            // a onda de syncs curtos
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await claim(["SOURCE_REFRESH"], [0, 1], { heavy: 4 }));
    expect(got.every((g) => g && g.weight === 0)).toBe(true);
  });

  it("teto de pesados: com o teto atingido, peso 2 espera; peso 0 continua", async () => {
    await add({ weight: 2, status: "RUNNING", lockedBy: "a-1@h" }); await add({ weight: 2, status: "RUNNING", lockedBy: "b-1@h" });
    await add({ weight: 2 }); await add({ weight: 0 });
    expect((await claim(null, [], { heavy: 2 }))!.weight).toBe(0);
    expect(await claim(null, [], { heavy: 2 })).toBeUndefined();          // só sobrou o pesado, teto cheio
    expect((await claim(null, [], { heavy: 3 }))!.weight).toBe(2);        // teto maior libera
  });

  it("limite por storage: storage cheio espera, outro storage segue", async () => {
    await add({ status: "RUNNING", storage: S1, lockedBy: "a-1@h" });
    await add({ storage: S1 }); await add({ storage: S2 });
    const g = await claim(null, [], { perStorage: 1 });
    expect(g).toBeDefined();
    const left = await pool.query(`SELECT storage_server_id FROM ${SCHEMA}.cw_jobs WHERE status='QUEUED'`);
    expect(left.rows.map((r) => r.storage_server_id)).toEqual([S1]);      // pegou o do S2; o do S1 ficou
    expect(await claim(null, [], { perStorage: 1 })).toBeUndefined();
  });

  it("ordem: mais antigo primeiro (FIFO) dentro do mesmo peso; job agendado para o futuro não é pego", async () => {
    await add({ availableIn: "-10 seconds" }); await add({ availableIn: "-30 seconds" }); await add({ availableIn: "+1 hour" });
    const a = await claim(null, []), b = await claim(null, []);
    const ids = await pool.query(`SELECT id, available_at FROM ${SCHEMA}.cw_jobs WHERE id = ANY($1::uuid[]) ORDER BY available_at`, [[a!.id, b!.id]]);
    expect(ids.rows).toHaveLength(2);
    expect(new Date(ids.rows[0].available_at) < new Date(ids.rows[1].available_at)).toBe(true);
    expect(await claim(null, [])).toBeUndefined();                          // o de +1h continua na fila
  });

  it("concorrência: 8 claims simultâneos pegam 8 jobs DISTINTOS (SKIP LOCKED)", async () => {
    for (let i = 0; i < 8; i++) await add({});
    const got = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(null, [], { by: `w-${i}` })));
    expect(got.every(Boolean)).toBe(true);
    expect(new Set(got.map((g) => g!.id)).size).toBe(8);
  });

  it("aspas em nome de tipo são escapadas no SQL (defesa; os tipos já são validados antes e por CHECK)", () => {
    expect(buildClaimSql(["A'B"])).toContain("'A''B'");
  });
});
