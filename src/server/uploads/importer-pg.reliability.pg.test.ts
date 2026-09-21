// @vitest-environment node
/**
 * Confiabilidade do import (atomicidade e integridade) contra Postgres REAL, pelo importUploadPg de verdade.
 *
 * Só roda com CW_TEST_PG_URL apontando para um Postgres DESCARTÁVEL que já tenha o schema do Catworld (prisma db push).
 * NUNCA produção: o teste cria e apaga um schema `rel_*` e deixa linhas de metadados.
 * Uso: CW_TEST_PG_URL=postgres://... npx vitest run src/server/uploads/importer-pg.reliability.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.CW_TEST_PG_URL;
vi.hoisted(() => {
  // o prisma e o env() leem isto no import: precisa estar definido ANTES
  if (process.env.CW_TEST_PG_URL) {
    process.env.CATWORLD_DATABASE_URL = process.env.CW_TEST_PG_URL;
    process.env.CATWORLD_ENCRYPTION_KEY ||= "k".repeat(32);
    process.env.AUTH_SECRET ||= "s".repeat(40);
  }
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const d = url ? describe : describe.skip;
const SCHEMA = `rel_${Date.now().toString(36)}`;  // único por execução: o metadado (schema_name é UNIQUE) sobra entre execuções

d("import Postgres: atomicidade e integridade (real)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-rel-"));
  const pool = new Pool({ connectionString: url });
  let prisma: typeof import("@/server/db").prisma;
  let importUploadPg: typeof import("./importer-pg").importUploadPg;
  let conn: import("@/server/storage/pg-storage").PgStorageConnection;
  let previewFile: typeof import("./parser").previewFile;
  let datasetId = "";

  beforeAll(async () => {
    ({ prisma } = await import("@/server/db"));
    ({ importUploadPg } = await import("./importer-pg"));
    ({ previewFile } = await import("./parser"));
    const { PgStorageConnection } = await import("@/server/storage/pg-storage");
    conn = new PgStorageConnection("rel-test", url!);
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    const proj = await prisma.project.create({ data: { name: "rel", slug: `rel-${Date.now()}` } });
    datasetId = (await prisma.dataset.create({ data: { projectId: proj.id, name: "rel", slug: "rel", schemaName: SCHEMA } })).id;
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  /** id 1..n; `tag` distingue o conteúdo de uma carga da outra; `bad` = linhas malformadas. */
  function file(name: string, n: number, tag = "v1", bad: Record<number, string> = {}, from = 1) {
    const lines = ["id,nome,valor"];
    for (let i = from; i < from + n; i++) lines.push(bad[i] ?? `${i},${tag} ${i},${i}.5`);
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  async function run(
    path: string, table: string, mode: "replace" | "append" | "upsert" = "replace", keyColumn?: string,
    opts: { rowCount?: number; id?: string; fullSnapshot?: boolean } = {},
  ) {
    const prev = await previewFile(path);
    const id = opts.id ?? randomUUID();
    const existing = await prisma.upload.findUnique({ where: { id } });
    if (!existing) {
      await prisma.upload.create({
        data: {
          id, datasetId, originalFilename: `${table}.csv`, blobName: `rel/${id}.csv`, sizeBytes: 1n, mode, keyColumn: keyColumn ?? null,
          fullSnapshot: opts.fullSnapshot ?? false,
          status: "IMPORTING", rowCount: BigInt(opts.rowCount ?? prev.rowCount), previewJson: JSON.stringify(prev), mappingJson: JSON.stringify(prev.columns),
        },
      });
    }
    return importUploadPg(id, path, conn);
  }
  const setSetting = (key: string, value: string) =>
    prisma.$executeRawUnsafe(`INSERT INTO cw_system_settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2`, key, value);
  const clearSetting = (key: string) => prisma.$executeRawUnsafe(`DELETE FROM cw_system_settings WHERE key=$1`, key);
  const expectedFingerprintMixed = async (n1: number, n2: number) =>
    (await pool.query(
      `SELECT md5(string_agg(i || '|' || CASE WHEN i <= $1 THEN 'v1 ' ELSE 'v2 ' END || i || '|' || trim_scale((i || '.5')::numeric)::text, ',' ORDER BY i)) h FROM generate_series(1, $2::bigint) i`,
      [n1, n1 + n2])).rows[0].h as string;

  const count = async (t: string) => Number((await pool.query(`SELECT count(*) n FROM ${SCHEMA}.${t}`)).rows[0].n);
  /** impressão digital do conteúdo: qualquer linha faltando/duplicada/alterada muda o md5 */
  const fingerprint = async (t: string) =>
    (await pool.query(`SELECT md5(string_agg(id || '|' || nome || '|' || trim_scale(valor::numeric)::text, ',' ORDER BY id::bigint)) h FROM ${SCHEMA}.${t}`)).rows[0].h as string;
  const expectedFingerprint = async (n: number, tag: string, from = 1) =>
    (await pool.query(`SELECT md5(string_agg(i || '|' || '${tag} ' || i || '|' || trim_scale((i || '.5')::numeric)::text, ',' ORDER BY i)) h FROM generate_series($1::bigint, $2::bigint) i`, [from, from + n - 1])).rows[0].h as string;

  it("replace: linhas e conteúdo idênticos ao arquivo", async () => {
    await run(file("a.csv", 5000), "t_replace");
    expect(await count("t_replace")).toBe(5000);
    expect(await fingerprint("t_replace")).toBe(await expectedFingerprint(5000, "v1"));
    // o consumo incremental (rows?since=) filtra por cw_synced_at: precisa de índice (190-340 ms → 1-4 ms medidos em 500k linhas)
    const idx = (await pool.query(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname = $1 AND tablename = 't_replace' AND indexdef LIKE '%cw_synced_at%'`, [SCHEMA])).rows[0].n;
    expect(idx).toBe(1);
  });

  it("replace sobre tabela existente (troca atômica): vira exatamente a carga nova", async () => {
    await run(file("b1.csv", 3000, "v1"), "t_swap");
    await run(file("b2.csv", 4500, "v2"), "t_swap");
    expect(await count("t_swap")).toBe(4500);
    expect(await fingerprint("t_swap")).toBe(await expectedFingerprint(4500, "v2"));
  });

  it("o BUG REAL: linha com coluna a mais (TIP-07): o import é RECUSADO nomeando a linha e nada é publicado pela metade", async () => {
    const n = 60_000;
    await expect(run(file("c.csv", n, "v1", { 50_000: "50000,x,1,SOBRA,MAIS" }), "t_bad")).rejects.toThrow(/Linha 50001/);
    // antes: 49.152 linhas entregues sem erro; depois do 1o hotfix: 60.000 com as celulas extras perdidas; agora: falha alta
    await expect(count("t_bad")).rejects.toThrow();   // a tabela nem foi criada
  }, 120_000);

  it("import que FALHA no meio não mexe na tabela existente (atomicidade)", async () => {
    await run(file("d1.csv", 3000, "v1"), "t_fail");
    const before = await fingerprint("t_fail");
    // aspas abertas e nunca fechadas: o parse aborta com erro no meio da carga
    const broken = file("d2.csv", 4000, "v2", { 2500: '2500,"aberta,5' });
    await expect(run(broken, "t_fail")).rejects.toThrow();
    expect(await count("t_fail")).toBe(3000);
    expect(await fingerprint("t_fail")).toBe(before);
  });

  it("reimportar depois de uma falha entrega o arquivo completo (sem herdar carga parcial)", async () => {
    await run(file("e1.csv", 2000, "v1"), "t_retry");
    await expect(run(file("e2.csv", 4000, "v2", { 2500: '2500,"aberta,5' }), "t_retry")).rejects.toThrow();
    await run(file("e3.csv", 4000, "v2"), "t_retry");
    expect(await count("t_retry")).toBe(4000);
    expect(await fingerprint("t_retry")).toBe(await expectedFingerprint(4000, "v2"));
  });

  it("um leitor concorrente NUNCA vê tabela vazia ou parcial durante um replace (isolamento/atomicidade)", async () => {
    await run(file("f1.csv", 20_000, "v1"), "t_reader");
    const seen = new Set<number>();
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        try { seen.add(await count("t_reader")); } catch { /* troca de tabela em andamento: erro transitório não é dado parcial */ }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await run(file("f2.csv", 80_000, "v2"), "t_reader");
    stop = true; await reader;
    expect([...seen].filter((n) => n !== 20_000 && n !== 80_000)).toEqual([]);   // só o estado antigo OU o novo completo
    expect(await count("t_reader")).toBe(80_000);
  }, 180_000);

  it("dois imports simultâneos na MESMA tabela: o resultado é exatamente UM deles, nunca uma mistura", async () => {
    await Promise.allSettled([run(file("g1.csv", 30_000, "A"), "t_conc"), run(file("g2.csv", 45_000, "B"), "t_conc")]);
    const n = await count("t_conc");
    expect([30_000, 45_000]).toContain(n);
    expect(await fingerprint("t_conc")).toBe(await expectedFingerprint(n, n === 30_000 ? "A" : "B"));
  }, 180_000);

  it("append: acrescenta exatamente as linhas novas", async () => {
    await run(file("h1.csv", 1000, "v1"), "t_append");
    await run(file("h2.csv", 500, "v2", {}, 1001), "t_append", "append");
    expect(await count("t_append")).toBe(1500);
  });

  it("upsert: atualiza as chaves existentes e insere as novas; repetir não muda nada (idempotente)", async () => {
    await run(file("i1.csv", 2000, "v1"), "t_upsert");
    await run(file("i2.csv", 1500, "v2", {}, 1501), "t_upsert", "upsert", "id"); // 1501..3000: 500 existentes + 1000 novas
    expect(await count("t_upsert")).toBe(3000);
    const rows = (await pool.query(`SELECT count(*) FILTER (WHERE nome LIKE 'v1 %') v1, count(*) FILTER (WHERE nome LIKE 'v2 %') v2 FROM ${SCHEMA}.t_upsert`)).rows[0];
    expect([Number(rows.v1), Number(rows.v2)]).toEqual([1500, 1500]);
    const h1 = await fingerprint("t_upsert");
    await run(file("i3.csv", 1500, "v2", {}, 1501), "t_upsert", "upsert", "id");
    expect(await count("t_upsert")).toBe(3000);
    expect(await fingerprint("t_upsert")).toBe(h1);
  }, 120_000);

  it("upsert com chave duplicada no arquivo: recusa (não escolhe uma linha em silêncio) e não altera a tabela", async () => {
    await run(file("j1.csv", 100, "v1"), "t_dup");
    const before = await fingerprint("t_dup");
    await expect(run(file("j2.csv", 50, "v2", { 10: "9,dup,1" }), "t_dup", "upsert", "id")).rejects.toThrow();
    expect(await fingerprint("t_dup")).toBe(before);
  });

  // ── Plano de confiabilidade: integridade, exactly-once, tipos, chave nula ─────────────────────────────────

  it("INTEGRIDADE: arquivo com menos linhas que o esperado NÃO troca a tabela (o incidente da ADL)", async () => {
    await run(file("k1.csv", 3000, "v1"), "t_integ");
    const before = await fingerprint("t_integ");
    // o preview disse 5000 linhas, mas só 1200 chegaram (simula a carga interrompida)
    await expect(run(file("k2.csv", 1200, "v2"), "t_integ", "replace", undefined, { rowCount: 5000 })).rejects.toThrow(/\[integrity\] ROWS_BELOW_EXPECTED/);
    expect(await count("t_integ")).toBe(3000);
    expect(await fingerprint("t_integ")).toBe(before);
    const stage = (await pool.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'cw_stage_%'`, [SCHEMA])).rows[0].n;
    expect(stage).toBe(0);                                          // sem staging órfã
    // a evidência fica registrada: uma linha COMPLETED/OK da 1ª carga e uma FAILED com o motivo estruturado da 2ª
    const led = (await pool.query(`SELECT outcome, verdict, expected_rows::int e, parsed_rows::int p, prev_rows::int pr, detail_json FROM cw_load_ledger WHERE table_name = 't_integ' AND dataset_id = $1 ORDER BY created_at`, [datasetId])).rows;
    expect(led.map((r) => [r.outcome, r.verdict])).toEqual([["COMPLETED", "OK"], ["FAILED", "FAILED"]]);
    expect(led[1]).toMatchObject({ e: 5000 });
    expect(JSON.parse(led[1].detail_json).reasons.map((x: { code: string }) => x.code)).toContain("ROWS_BELOW_EXPECTED");
    const ev = (await pool.query(`SELECT count(*)::int n FROM cw_audit_events WHERE event_type = 'DATA_INTEGRITY_SUSPECT' AND detail_json LIKE '%t_integ%' AND detail_json LIKE $1 AND success = false`, [`%${datasetId}%`])).rows[0].n;
    expect(ev).toBe(1);
  });

  it("INTEGRIDADE: substituir tabela com dados por arquivo só com cabeçalho é barrado (a menos que allow_empty)", async () => {
    await run(file("l1.csv", 500, "v1"), "t_empty");
    await expect(run(file("l2.csv", 0, "v2"), "t_empty")).rejects.toThrow(/EMPTY_REPLACE/);
    expect(await count("t_empty")).toBe(500);
    await setSetting("integrity.allow_empty", "true");
    try {
      await run(file("l3.csv", 0, "v2"), "t_empty");
      expect(await count("t_empty")).toBe(0);
    } finally { await clearSetting("integrity.allow_empty"); }
  });

  it("INTEGRIDADE: modo warn publica (e avisa) em vez de barrar", async () => {
    await run(file("m1.csv", 800, "v1"), "t_warn");
    await setSetting("integrity.mode", "warn");
    try {
      await run(file("m2.csv", 300, "v2"), "t_warn", "replace", undefined, { rowCount: 900 });
      expect(await count("t_warn")).toBe(300);
    } finally { await clearSetting("integrity.mode"); }
  });

  it("EXACTLY-ONCE: append reexecutado com o mesmo upload NÃO duplica (queda entre o COMMIT e os metadados)", async () => {
    await run(file("n1.csv", 1000, "v1"), "t_once");
    const id = randomUUID();
    const f = file("n2.csv", 500, "v2", {}, 1001);
    await run(f, "t_once", "append", undefined, { id });
    expect(await count("t_once")).toBe(1500);
    // a retentativa do MESMO upload (o job foi recolocado na fila): nada é acrescentado de novo
    await run(f, "t_once", "append", undefined, { id });
    expect(await count("t_once")).toBe(1500);
    expect(await fingerprint("t_once")).toBe(await expectedFingerprintMixed(1000, 500));
    // a marca é do upload: um upload NOVO com o mesmo arquivo continua acrescentando (é outra carga)
    await run(f, "t_once", "append");
    expect(await count("t_once")).toBe(2000);
  });

  it("TIPOS: append/upsert nunca estreita a coluna (DECIMAL em BIGINT arredondava)", async () => {
    const dec = join(dir, "o1.csv"); writeFileSync(dec, "id,nome,valor\n1,a,1.5\n2,b,2.5\n");
    await run(dec, "t_narrow");
    const ints = join(dir, "o2.csv"); writeFileSync(ints, "id,nome,valor\n3,c,7\n4,d,8\n"); // inferido BIGINT: cabe em DECIMAL, sem perda
    await run(ints, "t_narrow", "append");
    expect(await count("t_narrow")).toBe(4);
    const v = (await pool.query(`SELECT valor::text v FROM ${SCHEMA}.t_narrow WHERE id::int = 1`)).rows[0].v;
    expect(Number(v)).toBe(1.5);                                     // não virou 2
    // o contrário: tabela BIGINT recebendo decimais é recusado, sem tocar a tabela
    const intTable = join(dir, "o3.csv"); writeFileSync(intTable, "id,nome,valor\n1,a,10\n2,b,20\n");
    await run(intTable, "t_narrow2");
    const decimals = join(dir, "o4.csv"); writeFileSync(decimals, "id,nome,valor\n3,c,1.6\n4,d,2.4\n");
    await expect(run(decimals, "t_narrow2", "append")).rejects.toThrow(/Tipos incompatíveis/);
    expect(await count("t_narrow2")).toBe(2);
  });

  it("UPSERT: chave nula é recusada (inseria uma linha nova a cada execução)", async () => {
    await run(file("p1.csv", 10, "v1"), "t_nullkey");
    const bad = join(dir, "p2.csv"); writeFileSync(bad, "id,nome,valor\n5,x,1.5\n,sem chave,2.5\n");
    await expect(run(bad, "t_nullkey", "upsert", "id")).rejects.toThrow(/chave nula/);
    expect(await count("t_nullkey")).toBe(10);
  });

  it("UPSERT com fullSnapshot e arquivo vazio: barrado, nada é escondido", async () => {
    await run(file("q1.csv", 100, "v1"), "t_snap");
    await expect(run(file("q2.csv", 0, "v2"), "t_snap", "upsert", "id", { fullSnapshot: true })).rejects.toThrow(/EMPTY_REPLACE/);
    const visible = (await pool.query(`SELECT count(*)::int n FROM ${SCHEMA}.t_snap WHERE cw_deleted_at IS NULL`)).rows[0].n;
    expect(visible).toBe(100);
  });

  it("PIPELINE: erro num lote INSERIDO em paralelo ao parse falha o import (sem rejeição solta) e não toca a tabela", async () => {
    await run(file("s1.csv", 2000, "v1"), "t_pipe");
    const before = await fingerprint("t_pipe");
    // 6000 linhas; a coluna valor foi mapeada como BIGINT e na linha 5000 chega "abc": o INSERT desse lote falha enquanto o parser já lê o próximo
    const bad = file("s2.csv", 6000, "v2", { 5000: "5000,x,abc" });
    const prev = await previewFile(bad);
    const mapping = prev.columns.map((c) => (c.sqlName === "valor" ? { ...c, sqlType: "BIGINT" } : c));
    const id = randomUUID();
    await prisma.upload.create({ data: { id, datasetId, originalFilename: "t_pipe.csv", blobName: `rel/${id}.csv`, sizeBytes: 1n, mode: "replace", status: "IMPORTING", rowCount: 6000n, previewJson: JSON.stringify(prev), mappingJson: JSON.stringify(mapping) } });
    await expect(importUploadPg(id, bad, conn)).rejects.toThrow();
    expect(await count("t_pipe")).toBe(2000);
    expect(await fingerprint("t_pipe")).toBe(before);
    const stages = (await pool.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name = $2`, [SCHEMA, `cw_stage_${id.replaceAll("-", "").slice(0, 20)}`])).rows[0].n;
    expect(stages).toBe(0);                                        // sem staging órfã
  });

  it("#1 TIPOS: data/decimal AMBIGUOS no arquivo herdam DATE/DECIMAL da tabela existente (append e upsert), nao viram texto", async () => {
    // carga 1 (nao ambigua: dia 25 > 12 e 1.234,50 so pode ser decimal com virgula) cria DATE e DECIMAL(?,2)
    const f1 = join(dir, "amb1.csv"); writeFileSync(f1, "id,dia,valor\n1,25/01/2026,\"1.234,50\"\n2,26/01/2026,\"9,25\"\n");
    await run(f1, "t_amb");
    expect((await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='t_amb' AND column_name='dia'`, [SCHEMA])).rows[0].data_type).toBe("date");
    // carga 2: todos os dias <= 12 e "1.234" ambiguo: sozinha vira texto; contra a tabela deve usar dd/mm e virgula decimal
    const f2 = join(dir, "amb2.csv"); writeFileSync(f2, "id,dia,valor\n3,01/02/2026,1.234\n4,03/04/2026,2.500\n");
    expect((await previewFile(f2)).columns.find((c) => c.sqlName === "dia")!.sqlType).toBe("NVARCHAR(MAX)"); // premissa do bug
    await run(f2, "t_amb", "append");
    const got = (await pool.query(`SELECT id::int i, dia::text d, valor::text v FROM ${SCHEMA}.t_amb ORDER BY id::int`)).rows;
    expect(got.map((r) => r.d)).toEqual(["2026-01-25", "2026-01-26", "2026-02-01", "2026-04-03"]);
    expect([Number(got[2].v), Number(got[3].v)]).toEqual([1234, 2500]);   // convenção da tabela (virgula decimal): "1.234" = ponto de milhar
    // upsert tambem
    const f3 = join(dir, "amb3.csv"); writeFileSync(f3, "id,dia,valor\n4,05/06/2026,7,5\n".replace("7,5", "\"7,5\""));
    await run(f3, "t_amb", "upsert", "id");
    expect((await pool.query(`SELECT dia::text d FROM ${SCHEMA}.t_amb WHERE id::int = 4`)).rows[0].d).toBe("2026-06-05");
  });

  it("#1 TIPOS: ambiguo SEM convencao conhecida na tabela falha alto, nao repetivel, e nada e gravado", async () => {
    await run(join(dir, "amb1.csv"), "t_amb_noconv");
    const tbl = await prisma.datasetTable.findUniqueOrThrow({ where: { datasetId_sqlName: { datasetId, sqlName: "t_amb_noconv" } } });
    await prisma.datasetVersion.deleteMany({ where: { tableId: tbl.id } });
    const f2 = join(dir, "amb4.csv"); writeFileSync(f2, "id,dia,valor\n3,01/02/2026,9\n");
    await expect(run(f2, "t_amb_noconv", "append")).rejects.toThrow(/ambíguas/);
    expect(await count("t_amb_noconv")).toBe(2);
  });

  it("ARQUIVO SEM COLUNAS: upload FAILED com motivo, tabela intacta (antes: COMPLETED com 0 linhas)", async () => {
    await run(file("r1.csv", 50, "v1"), "t_nocols");
    const nocols = join(dir, "r2.csv"); writeFileSync(nocols, "");
    const id = randomUUID();
    await prisma.upload.create({ data: { id, datasetId, originalFilename: "t_nocols.csv", blobName: `rel/${id}.csv`, sizeBytes: 0n, mode: "replace", status: "IMPORTING", mappingJson: "[]" } });
    await importUploadPg(id, nocols, conn);
    const up = await prisma.upload.findUnique({ where: { id } });
    expect(up?.status).toBe("FAILED");
    expect(up?.errorMessage).toMatch(/sem colunas/);
    expect(await count("t_nocols")).toBe(50);
  });
});
