// @vitest-environment node
/**
 * Criacao do registro exactly-once (cw_internal) contra Postgres REAL: em paralelo (o `CREATE SCHEMA IF NOT EXISTS` sozinho falhava com
 * 23505 quando varios appends criavam ao mesmo tempo) e sem permissao (falha alto, nao segue sem exactly-once).
 * Usa bancos descartaveis proprios (cw_marker_*), nunca o banco de teste compartilhado. So roda com CW_TEST_PG_URL.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PG_MARKER_DDL, ensurePgMarker } from "./applied-marker";
import { isNonRetryable } from "./non-retryable";

const url = process.env.CW_TEST_PG_URL;
const d = url ? describe : describe.skip;

function withDb(u: string, db: string, user?: string, password?: string): string {
  const x = new URL(u);
  x.pathname = `/${db}`;
  if (user) { x.username = user; x.password = password ?? ""; }
  return x.toString();
}

d("registro exactly-once: criacao (Postgres real)", () => {
  const admin = new Pool({ connectionString: url });
  const created: string[] = [];
  const role = `cw_np_${Date.now().toString(36)}`;

  async function freshDb() {
    const name = `cw_marker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    return name;
  }
  const conn = (u: string) => {
    const pool = new Pool({ connectionString: u, max: 2 });
    return {
      pool,
      queryParams: async <T>(sql: string, p: unknown[]) => (await pool.query(sql, p)).rows as T[],
      execute: async (sql: string) => pool.query(sql),
    };
  };

  afterAll(async () => {
    for (const n of created) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}_2`).catch(() => undefined);
    await admin.end();
  });

  it("varios appends criando o registro ao mesmo tempo: todos passam (antes: 5/5 falhavam com 23505)", async () => {
    const db = await freshDb();
    const conns = Array.from({ length: 8 }, () => conn(withDb(url!, db)));
    try {
      const rs = await Promise.allSettled(conns.map((c) => ensurePgMarker(c)));
      expect(rs.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      const ok = (await admin.query(`SELECT 1`)).rowCount;
      expect(ok).toBe(1);
      const c = conns[0]!;
      expect((await c.queryParams<{ ok: boolean }>(`SELECT to_regclass('cw_internal.applied_uploads') IS NOT NULL AS ok`, []))[0]!.ok).toBe(true);
      await ensurePgMarker(c); // idempotente (caminho rapido)
    } finally { await Promise.all(conns.map((c) => c.pool.end())); }
  });

  it("premissa: o DDL cru em paralelo realmente corre (documenta o bug original)", async () => {
    const db = await freshDb();
    const conns = Array.from({ length: 8 }, () => conn(withDb(url!, db)));
    try {
      const rs = await Promise.allSettled(conns.map(async (c) => { for (const ddl of PG_MARKER_DDL) await c.execute(ddl); }));
      const codes = rs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.code);
      // se o servidor for rapido o bastante a corrida pode nao ocorrer; quando ocorre, e um dos codigos tolerados
      for (const c of codes) expect(["23505", "42P06", "42P07"]).toContain(c);
    } finally { await Promise.all(conns.map((c) => c.pool.end())); }
  });

  it("sem permissao de CREATE: falha ALTO e nao repetivel (nunca segue sem exactly-once)", async () => {
    const db = await freshDb();
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'np'`);
    const c = conn(withDb(url!, db, role, "np"));
    try {
      let err: unknown;
      try { await ensurePgMarker(c); } catch (e) { err = e; }
      expect((err as Error)?.message).toMatch(/Sem permissão para criar o registro exactly-once/);
      expect(isNonRetryable(err)).toBe(true);
    } finally { await c.pool.end(); }
  });

  it("registro ja existente e usuario sem permissao de CREATE: segue (nao roda DDL)", async () => {
    const db = await freshDb();
    const a = conn(withDb(url!, db));
    await ensurePgMarker(a);
    await a.pool.end();
    await admin.query(`CREATE ROLE ${role}_2 LOGIN PASSWORD 'np'`);
    const adm = conn(withDb(url!, db));
    await adm.execute(`GRANT USAGE ON SCHEMA cw_internal TO ${role}_2`);
    await adm.pool.end();
    const c = conn(withDb(url!, db, `${role}_2`, "np"));
    try { await expect(ensurePgMarker(c)).resolves.toBeUndefined(); } finally { await c.pool.end(); }
  });
});
