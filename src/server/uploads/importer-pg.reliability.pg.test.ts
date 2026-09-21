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

  async function run(path: string, table: string, mode: "replace" | "append" | "upsert" = "replace", keyColumn?: string) {
    const prev = await previewFile(path);
    const id = randomUUID();
    await prisma.upload.create({
      data: {
        id, datasetId, originalFilename: `${table}.csv`, blobName: `rel/${id}.csv`, sizeBytes: 1n, mode, keyColumn: keyColumn ?? null,
        status: "IMPORTING", rowCount: BigInt(prev.rowCount), previewJson: JSON.stringify(prev), mappingJson: JSON.stringify(prev.columns),
      },
    });
    return importUploadPg(id, path, conn);
  }

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
  });

  it("replace sobre tabela existente (troca atômica): vira exatamente a carga nova", async () => {
    await run(file("b1.csv", 3000, "v1"), "t_swap");
    await run(file("b2.csv", 4500, "v2"), "t_swap");
    expect(await count("t_swap")).toBe(4500);
    expect(await fingerprint("t_swap")).toBe(await expectedFingerprint(4500, "v2"));
  });

  it("o BUG REAL: linha com coluna a mais depois da amostra do sniffer — todas as linhas chegam ao banco", async () => {
    const n = 60_000;
    await run(file("c.csv", n, "v1", { 50_000: "50000,x,1,SOBRA,MAIS" }), "t_bad");
    expect(await count("t_bad")).toBe(n);                          // antes: 49.152 (perdia o resto em silêncio)
    const ids = (await pool.query(`SELECT count(DISTINCT id) n FROM ${SCHEMA}.t_bad`)).rows[0].n;
    expect(Number(ids)).toBe(n);                                    // sem duplicata
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
});
