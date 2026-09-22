/**
 * Confiabilidade de fontes conectadas contra Postgres REAL (ERP falso = banco proprio criado aqui; storage = schema unico no
 * banco de teste). So roda com CW_TEST_PG_URL (Postgres descartavel — NUNCA producao). Oraculo = o proprio ERP consultado
 * direto, nunca o codigo sob teste. Rodar tambem com TZ=Asia/Tokyo e TZ=America/New_York (nada aqui pode depender do fuso).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "crypto";

const creds = vi.hoisted(() => ({ password: "test" }));
const db = vi.hoisted(() => ({ src: null as any, catalog: [] as any[], jobs: [] as any[] }));

const matches = (row: any, where: any): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every(w => matches(row, w));
    if (k === "OR") return (v as any[]).some(w => matches(row, w));
    if (k === "NOT") return !matches(row, v);
    const val = row[k];
    if (v === null) return val == null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return v.not === null ? val != null : val !== v.not;
      if ("lt" in v) return val != null && val < v.lt;
      if ("contains" in v) return typeof val === "string" && val.includes(v.contains);
      return true;
    }
    return val === v;
  });
};

vi.mock("@/server/security/crypto", () => ({ decryptSecret: () => JSON.stringify({ password: creds.password }) }));
vi.mock("@/server/db/advisory-lock", () => ({ withAdvisoryLock: (_k: string, fn: () => unknown) => fn() }));
vi.mock("@/server/azure/sql", () => ({ sqlPool: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("@/server/db", () => ({
  prisma: {
    datasetSource: {
      findUnique: vi.fn(async () => ({ ...db.src, targetTable: { ...db.src.targetTable, columns: db.catalog } })),
      findUniqueOrThrow: vi.fn(async () => ({ ...db.src, dataset: db.src.dataset })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!matches(db.src, where)) return { count: 0 };
        Object.assign(db.src, data, { updatedAt: data.updatedAt ?? new Date() });
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => { Object.assign(db.src, data, { updatedAt: new Date() }); return db.src; }),
    },
    datasetColumn: {
      deleteMany: vi.fn(async () => { db.catalog = []; return {}; }),
      createMany: vi.fn(async ({ data }: any) => { db.catalog = data.map((d: any) => ({ sqlName: d.sqlName, sqlType: d.sqlType, originalName: d.originalName, ordinal: d.ordinal })); return {}; }),
    },
    datasetTable: { update: vi.fn(async () => ({})) },
    datasetVersion: { create: vi.fn(async () => ({})) },
    job: { findMany: vi.fn(async () => []), create: vi.fn(async ({ data }: any) => { db.jobs.push(data); return { id: "j", ...data }; }) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));
// A conexao e criada na CHAMADA (nao na factory): importar pg-storage dentro da factory faz um ciclo com este mock e trava.
vi.mock("@/server/storage/connection", () => {
  let conn: unknown;
  return {
    CW_SYNCED_AT: "cw_synced_at",
    CW_DELETED_AT: "cw_deleted_at",
    userColumnNames: (cols: readonly { name: string }[]) => cols.map(c => c.name).filter(n => n !== "_cw_rh" && n !== "cw_synced_at" && n !== "cw_deleted_at"),
    KEYS_CHECK_MAX_RATIO: 0.3,
    KEYS_CHECK_RATIO_MIN_LIVE: 50,
    getStorageConnection: vi.fn(async () => {
      if (!conn) {
        const { PgStorageConnection } = await import("@/server/storage/pg-storage");
        conn = new PgStorageConnection(`rel-${process.pid}`, process.env.CW_TEST_PG_URL ?? "postgres://x");
      }
      return conn;
    }),
  };
});

import { refreshDatasetSource } from "./sources";
import { streamPostgresRows } from "./postgres";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;
const SFX = randomUUID().replaceAll("-", "").slice(0, 10);
const ERP_DB = `cw_erp_${SFX}`;
const SCHEMA = `cw_t_${SFX}`;
const RLS_ROLE = `cw_rls_${SFX}`;

d("fontes conectadas: confiabilidade (Postgres real)", () => {
  let admin: Pool, erp: Pool, storage: Pool;
  const u = url ? new URL(url) : null;
  const baseConn = () => ({
    provider: "postgres", server: u!.hostname, port: Number(u!.port), databaseName: ERP_DB, username: decodeURIComponent(u!.username),
    encryptedCredentials: "x", sslMode: "disable",
  });

  function newSource(over: Record<string, unknown> = {}, table = "orders") {
    db.catalog = [];
    db.src = {
      id: randomUUID(), active: true, mode: "extract", sourceKind: "table", sourceSchema: "public", sourceTable: table,
      deltaColumn: "Upd", lastDeltaValue: null, keyColumn: "Id", refreshCron: "0 * * * *", reconciliationCron: null,
      sourceSql: null, sourceSqlReconciliation: null, detectDeletions: false, keysSql: null, keysMinIntervalMinutes: null,
      lastKeysCheckAt: null, lastRowCount: null, lastError: null, lastStatus: "queued", avgRunMs: null, updatedAt: new Date(),
      dataset: { storageServerId: null, schemaName: SCHEMA }, connection: baseConn(), targetTable: { id: "tt", sqlName: table },
      ...over,
    };
    return db.src;
  }
  const stor = (sql: string) => storage.query(sql).then(r => r.rows);
  const erpq = (sql: string) => erp.query(sql).then(r => r.rows);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${ERP_DB}`);
    const eu = new URL(url!); eu.pathname = `/${ERP_DB}`;
    erp = new Pool({ connectionString: eu.toString() });
    storage = new Pool({ connectionString: url });
    await storage.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  });
  afterAll(async () => {
    await erp?.end();
    await storage?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await storage?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${ERP_DB} WITH (FORCE)`);
    await admin?.query(`DROP ROLE IF EXISTS ${RLS_ROLE}`).catch(() => undefined);
    await admin?.end();
  });
  beforeEach(async () => { creds.password = "test"; db.jobs.length = 0; });

  async function resetOrders(n = 120) {
    await erpq(`DROP TABLE IF EXISTS public.orders; CREATE TABLE public.orders ("Id" bigint PRIMARY KEY, "Upd" timestamp(6), "Val" text)`);
    await erpq(`INSERT INTO public.orders SELECT g, timestamp '2026-03-01 10:00:00' + g * interval '1 minute' + interval '0.123456 seconds', 'v' || g FROM generate_series(1, ${n}) g`);
    await storage.query(`DROP TABLE IF EXISTS ${SCHEMA}.orders`);
  }
  const storageIds = async () => (await stor(`SELECT id FROM ${SCHEMA}.orders ORDER BY id`)).map(r => String(r.id));

  it("FON-02/H4: empate na marca e commit tardio (dentro da janela) entram; delta NULL e o que ficou alem da janela so a reconciliacao pega (o incremental nao re-le NULL); sem duplicar", async () => {
    await resetOrders();
    const s = newSource();
    await refreshDatasetSource(s.id);
    const max = (await erpq(`SELECT max("Upd")::text AS m FROM public.orders`))[0].m as string; // 2026-03-01 12:00:00.123456
    expect(s.lastDeltaValue).toBe(max); // marca vem do texto cru, com microssegundos
    expect(await storageIds()).toHaveLength(120);

    await erpq(`INSERT INTO public.orders VALUES (1001, '${max}', 'empate')`);                                   // igual a marca
    await erpq(`INSERT INTO public.orders VALUES (1002, NULL, 'nulo')`);                                          // delta NULL
    await erpq(`INSERT INTO public.orders VALUES (1003, timestamp '${max}' - interval '5 minutes', 'tardio')`);  // commit tardio dentro da janela
    await erpq(`INSERT INTO public.orders VALUES (1004, timestamp '${max}' - interval '3 hours', 'alem')`);      // alem da janela
    await refreshDatasetSource(s.id);
    const ids = await storageIds();
    expect(ids).toContain("1001"); expect(ids).toContain("1003");
    expect(ids).not.toContain("1002"); // H4: linha NOVA com delta NULL chega na reconciliacao (o incremental nao re-le todas as de delta NULL)
    expect(ids).not.toContain("1004");
    await refreshDatasetSource(s.id); // repetir e inofensivo
    expect(await storageIds()).toEqual(ids);
    expect((await stor(`SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM ${SCHEMA}.orders`))[0]).toEqual({ n: ids.length, d: ids.length });

    await refreshDatasetSource(s.id, { reconciliation: true });
    expect(await storageIds()).toContain("1004");
    expect(await storageIds()).toContain("1002");
    // oraculo: storage == ERP
    const a = await erpq(`SELECT "Id"::text AS id, "Val" AS v FROM public.orders ORDER BY 1`);
    const b = await stor(`SELECT id::text AS id, val AS v FROM ${SCHEMA}.orders ORDER BY 1`);
    expect(b).toEqual(a);
  });

  it("FON-01: valor em 2099 nao congela a fonte (marca limitada + aviso); marca ja contaminada se cura por recarga", async () => {
    await resetOrders();
    await erpq(`INSERT INTO public.orders VALUES (2000, '2099-12-31 00:00:00', 'futuro')`);
    const s = newSource();
    await refreshDatasetSource(s.id);
    expect(s.lastDeltaValue!.startsWith("2099")).toBe(false);
    expect(s.lastError).toMatch(/DELTA_FUTURE_VALUES/);
    expect(s.lastStatus).toBe("completed");
    // a fonte continua andando
    await erpq(`INSERT INTO public.orders VALUES (2001, now() at time zone 'utc', 'novo')`);
    await refreshDatasetSource(s.id);
    expect(await storageIds()).toContain("2001");

    // marca antiga ja gravada em 2099 (versao anterior do codigo): recarga integral e marca recalculada
    const poisoned = newSource({ lastDeltaValue: "2099-12-31T00:00:00.000Z" });
    await erpq(`DELETE FROM public.orders WHERE "Id" = 2000`);
    await refreshDatasetSource(poisoned.id);
    expect(poisoned.lastError).toMatch(/DELTA_RESET/);
    expect(poisoned.lastDeltaValue!.startsWith("2099")).toBe(false);
    expect(await storageIds()).toContain("2001");
  });

  it("FON-14: chave/delta digitados com o nome ORIGINAL (maiuscula) funcionam contra o storage saneado", async () => {
    await resetOrders(5);
    const s = newSource({ keyColumn: "Id", deltaColumn: "Upd" });
    await refreshDatasetSource(s.id);
    await erpq(`UPDATE public.orders SET "Val" = 'alterado', "Upd" = "Upd" + interval '1 hour' WHERE "Id" = 3`);
    await refreshDatasetSource(s.id);
    expect((await stor(`SELECT val FROM ${SCHEMA}.orders WHERE id = 3`))[0].val).toBe("alterado");
    expect(await storageIds()).toHaveLength(5);
  });

  it("FON-04/10/13: tipos chegam fieis (numeric exato, NaN/1e300 como texto, jsonb, bytea, interval, timestamptz, microssegundos, arrays, timetz)", async () => {
    await erpq(`DROP TABLE IF EXISTS public.tipos; CREATE TABLE public.tipos (
      n1 numeric(30,9), n2 numeric, f float8, j jsonb, b bytea, iv interval, tz timestamptz, ts timestamp(6), d date, ar int[], tt timetz, txt text)`);
    await erpq(`INSERT INTO public.tipos VALUES
      (123456789012345678.123456789, 'NaN', 'NaN', '{"a":  1,"b":[1,{"c":null}]}', '\\xdeadbeef', '1 year 2 mons 3 days 04:05:06', '2026-03-01 23:30:00.123456-03', '2026-03-01 10:20:30.123456', '2026-03-01', '{1,2,NULL}', '10:00:00+02', 'ok'),
      (0.000000001, 1e300, 'Infinity', '[]', '\\x', '0', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00', '2026-01-01', '{}', '00:00:00+00', ''),
      (-99999999999999999999.999999999, 0.1234567890123456789, 1e300, 'null', '\\x00', '-1 days', '2026-06-01 00:00:00.5+09', '2026-06-01 00:00:00.5', '2026-06-01', '{{1,2},{3,4}}', '23:59:59-05', NULL)`);
    await storage.query(`DROP TABLE IF EXISTS ${SCHEMA}.tipos`);
    const s = newSource({ sourceTable: "tipos", targetTable: { id: "t2", sqlName: "tipos" }, keyColumn: null, deltaColumn: null });
    await refreshDatasetSource(s.id);
    const oracle = await (async () => {
      const c = await erp.connect();
      try {
        await c.query(`SET IntervalStyle TO 'iso_8601'; SET TimeZone TO 'UTC'`);
        return (await c.query(`SELECT n1::text n1, n2::text n2, f::text f, j::text j, b::text b, iv::text iv, tz::text tz, ts::text ts, d::text d, ar::text ar, tt::text tt, txt FROM public.tipos ORDER BY n1`)).rows;
      } finally { c.release(); }
    })();
    const got = await stor(`SELECT n1::text n1, n2::text n2, f::text f, j::text j, b::text b, iv::text iv, ${"tz::text"} tz, ts::text ts, d::text d, ar::text ar, tt::text tt, txt FROM ${SCHEMA}.tipos ORDER BY n1::numeric`);
    // tz: storage guarda timestamp UTC sem offset; oraculo em UTC tem "+00"
    const norm = (r: any) => ({ ...r, tz: String(r.tz).replace(/\+00$/, "") });
    expect(got.map(norm)).toEqual(oracle.map(norm));
    const types = await stor(`SELECT column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='tipos' ORDER BY ordinal_position`);
    expect(types[0]).toMatchObject({ column_name: "n1", data_type: "numeric", numeric_precision: 30, numeric_scale: 9 });
    expect(types[1]).toMatchObject({ column_name: "n2", data_type: "text" });
    expect(types[2]).toMatchObject({ column_name: "f", data_type: "text" });
  });

  it("FON-05: ERP que passa a devolver 0 linhas (RLS) NAO troca a tabela: IntegrityError, dados anteriores intactos, status failed", async () => {
    await resetOrders(120);
    await erpq(`DROP ROLE IF EXISTS ${RLS_ROLE}`).catch(() => undefined);
    await erpq(`CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD 'rls'`);
    await erpq(`GRANT SELECT ON public.orders TO ${RLS_ROLE}`);
    const s = newSource({ keyColumn: null, deltaColumn: null }); // sem chave: substituicao integral
    await refreshDatasetSource(s.id);
    expect(await storageIds()).toHaveLength(120);

    await erpq(`ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; CREATE POLICY nada ON public.orders FOR SELECT TO ${RLS_ROLE} USING (false)`);
    creds.password = "rls";
    s.connection = { ...baseConn(), username: RLS_ROLE };
    await expect(refreshDatasetSource(s.id)).rejects.toThrow(/\[integrity\].*EMPTY_REPLACE/);
    expect(s.lastStatus).toBe("failed");
    expect(s.lastError).toMatch(/A tabela anterior foi mantida/);
    expect(await storageIds()).toHaveLength(120);
    await erpq(`ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY`);
  });

  it("FON-05: reconciliacao que le queda grande (>30%) contra a versao anterior tambem nao troca", async () => {
    await resetOrders(120);
    const s = newSource();
    await refreshDatasetSource(s.id);
    await erpq(`DELETE FROM public.orders WHERE "Id" > 40`);
    await expect(refreshDatasetSource(s.id, { reconciliation: true })).rejects.toThrow(/DROP_GT_PCT/);
    expect(await storageIds()).toHaveLength(120);
    expect(s.lastStatus).toBe("failed");
  });

  it("FON-11/15: coluna renomeada na origem recarrega a tabela inteira (sem NULL nas linhas antigas)", async () => {
    await resetOrders(10);
    const s = newSource();
    await refreshDatasetSource(s.id);
    await erpq(`ALTER TABLE public.orders RENAME COLUMN "Val" TO "Valor"`);
    await refreshDatasetSource(s.id);
    expect(s.lastError).toMatch(/SCHEMA_CHANGED/);
    const rows = await stor(`SELECT id, valor FROM ${SCHEMA}.orders ORDER BY id`);
    expect(rows).toHaveLength(10);
    expect(rows.every(r => r.valor != null)).toBe(true);
    await erpq(`ALTER TABLE public.orders RENAME COLUMN "Valor" TO "Val"`);
  });

  it("FON-17: dono morto (running sem renovar) e assumido; running com renovacao recente continua dando 409", async () => {
    await resetOrders(5);
    const fresh = newSource({ lastStatus: "running", lastError: "lease:outro", updatedAt: new Date() });
    await expect(refreshDatasetSource(fresh.id)).rejects.toMatchObject({ code: "SOURCE_REFRESH_IN_PROGRESS" });
    const dead = newSource({ lastStatus: "running", lastError: "lease:morto", updatedAt: new Date(Date.now() - 60 * 60_000) });
    await refreshDatasetSource(dead.id);
    expect(dead.lastStatus).toBe("completed");
    expect(await storageIds()).toHaveLength(5);
  });

  it("FON-19: queda da conexao da origem no meio do stream falha limpo (sem erro nao tratado derrubando o processo)", async () => {
    await resetOrders(3000);
    const conn: any = baseConn();
    const it = streamPostgresRows(conn, `SELECT * FROM public.orders`, 500);
    const first = await it.next();
    expect(first.value).toHaveLength(500);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${ERP_DB}' AND pid <> pg_backend_pid() AND state = 'idle in transaction'`);
    await expect((async () => { for (;;) { const r = await it.next(); if (r.done) return; } })()).rejects.toBeTruthy();
    await new Promise(r => setTimeout(r, 200)); // da tempo de um 'error' assincrono vazar, se vazasse
  });
});
