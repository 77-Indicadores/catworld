// @vitest-environment node
/**
 * Fidelidade de valores ponta a ponta (arquivo -> previewFile -> importUploadPg -> Postgres real): TIP-01/02/06/11/13/15.
 * Só roda com CW_TEST_PG_URL (Postgres descartável com o schema do Catworld). Schema e slug únicos por execução.
 * Uso: CW_TEST_PG_URL=postgres://... npx vitest run src/server/uploads/type-fidelity.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.CW_TEST_PG_URL;
vi.hoisted(() => {
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
const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const SCHEMA = `tf_${TAG}`;

d("fidelidade de valores no import Postgres (real)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-tf-"));
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
    conn = new PgStorageConnection(`tf-${TAG}`, url!);
    const proj = await prisma.project.create({ data: { name: `tf ${TAG}`, slug: `tf-${TAG}` } });
    datasetId = (await prisma.dataset.create({ data: { projectId: proj.id, name: "tf", slug: `tf-${TAG}`, schemaName: SCHEMA } })).id;
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(content: string, table: string, overrides?: Record<string, string>) {
    const path = join(dir, `${table}.csv`);
    writeFileSync(path, content);
    const prev = await previewFile(path);
    if (overrides) { const { applyTypeOverrides } = await import("./parser"); applyTypeOverrides(prev.columns, overrides); }
    const id = randomUUID();
    await prisma.upload.create({
      data: {
        id, datasetId, originalFilename: `${table}.csv`, blobName: `tf/${id}.csv`, sizeBytes: 1n, mode: "replace",
        status: "IMPORTING", rowCount: BigInt(prev.rowCount), previewJson: JSON.stringify(prev), mappingJson: JSON.stringify(prev.columns),
      },
    });
    await importUploadPg(id, path, conn);
    return prev;
  }
  const rows = async (t: string, cols: string) => (await pool.query(`SELECT ${cols} FROM ${SCHEMA}.${t} ORDER BY n::bigint`)).rows;

  it("decimais: escala 6, 15+ dígitos, negativos e vírgula BR chegam idênticos ao arquivo", async () => {
    await run('n,us,br\n1,0.000123,"1.234,56"\n2,123456789012345.5,"0,5"\n3,-2.25,"-10,125"\n', "t_dec");
    const r = await rows("t_dec", "n, us::text us, br::text br");
    expect(r[0].us).toMatch(/^0\.000123/);        // (20,6) mantém zeros à direita da escala; o valor é o mesmo
    expect(Number(r[0].us)).toBe(0.000123);
    expect(r[1].us.replace(/0+$/, "")).toBe("123456789012345.5");
    expect(r[0].br.replace(/0+$/, "")).toBe("1234.56");
    expect(r[1].br.replace(/0+$/, "")).toBe("0.5");
    expect(r[2].br.replace(/0+$/, "")).toBe("-10.125");
  });

  it("legado: coluna que cabe em (18,4) continua NUMERIC(18,4) com os mesmos valores", async () => {
    await run("n,v\n1,10.50\n2,3.1415\n3,-2.5\n", "t_leg");
    const t = (await pool.query(`SELECT numeric_precision p, numeric_scale s FROM information_schema.columns WHERE table_schema=$1 AND table_name='t_leg' AND column_name='v'`, [SCHEMA])).rows[0];
    expect([t.p, t.s]).toEqual([18, 4]);
    expect((await rows("t_leg", "v::text v")).map((x) => Number(x.v))).toEqual([10.5, 3.1415, -2.5]);
  });

  it("'1,234' / '12' / '2,500' fica TEXT: o texto original, nunca 1.234", async () => {
    await run('n,v\n1,"1,234"\n2,12\n3,"2,500"\n', "t_amb");
    expect((await rows("t_amb", "v")).map((x) => x.v)).toEqual(["1,234", "12", "2,500"]);
  });

  it("-007 e 25:00 ficam texto exato", async () => {
    await run("n,a,b\n1,-007,25:00\n2,5,10:00\n", "t_txt");
    expect(await rows("t_txt", "a, b")).toEqual([{ a: "-007", b: "25:00" }, { a: "5", b: "10:00" }]);
  });

  it("datas dd/mm decididas pela coluna: 04/05/2026 = 4 de maio, todas ao mesmo tempo", async () => {
    await run("n,d\n1,04/05/2026\n2,31/01/2026\n", "t_dmy");
    expect((await rows("t_dmy", "to_char(d,'YYYY-MM-DD') d")).map((x) => x.d)).toEqual(["2026-05-04", "2026-01-31"]);
  });

  it("override que não converte FALHA o import (não vira NULL) e a tabela anterior fica intacta", async () => {
    await run("n,v\n1,a\n", "t_ovr");
    await expect(run("n,v\n1,5\n2,abc\n", "t_ovr", { v: "BIGINT" })).rejects.toThrow(/abc/);
    expect(await rows("t_ovr", "v")).toEqual([{ v: "a" }]);
  });

  it("override DECIMAL(10,2) é honrado FISICAMENTE (NUMERIC(10,2)) e valor com 3 casas FALHA em vez de arredondar", async () => {
    await run("n,v\n1,1.5\n2,2.25\n", "t_dov", { v: "decimal(10, 2)" });
    const t = (await pool.query(`SELECT numeric_precision p, numeric_scale s FROM information_schema.columns WHERE table_schema=$1 AND table_name='t_dov' AND column_name='v'`, [SCHEMA])).rows[0];
    expect([t.p, t.s]).toEqual([10, 2]);
    await expect(run("n,v\n1,1.234\n", "t_dov2", { v: "DECIMAL(10,2)" })).rejects.toThrow(/1\.234/);
    await expect(pool.query(`SELECT 1 FROM ${SCHEMA}.t_dov2`)).rejects.toThrow();   // nada foi publicado
  });
});
